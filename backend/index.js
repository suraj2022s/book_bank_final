import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import express from "express";
import cors from "cors";
import multer from "multer";
import { WebSocketServer } from "ws";
import xlsx from "xlsx";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH  = process.env.SSL_KEY_PATH;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const SMTP_URL = process.env.SMTP_URL || "";

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const LEDGER_FILE = path.join(DATA_DIR, "ledger.json");
const EMAIL_LOG = path.join(DATA_DIR, "email_logs.jsonl");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let state = { version: 0, rows: [] };
function loadLedger(){ if(fs.existsSync(LEDGER_FILE)){ try{ const j=JSON.parse(fs.readFileSync(LEDGER_FILE,'utf-8')); state.rows=j.rows||[]; state.version=j.version||0; }catch{} } }
function saveLedger(){ fs.writeFileSync(LEDGER_FILE, JSON.stringify({ version: state.version, rows: state.rows }, null, 2)); }
loadLedger();

const normEmail = (s="") => s.trim().toLowerCase();
const normCopy  = (s="") => s.trim().toLowerCase();
const validEmail = (s="") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
function toISODate(s=""){
  if (typeof s === "number") {
    const d = xlsx.SSF.parse_date_code(s);
    if (d) { const mm=String(d.m).padStart(2,"0"); const dd=String(d.d).padStart(2,"0"); return `${d.y}-${mm}-${dd}`; }
  }
  const dt = new Date(s);
  if (isNaN(dt)) return null;
  return dt.toISOString().slice(0,10);
}
function broadcast(type, payload={}){ const msg=JSON.stringify({ type, ...payload }); wss.clients.forEach(c=>{ try{ c.send(msg); }catch{} }); }

let transport = SMTP_URL ? nodemailer.createTransport(SMTP_URL) : nodemailer.createTransport({ jsonTransport: true });

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());
const upload = multer({ dest: UPLOAD_DIR });

app.get("/api/health",(req,res)=>res.json({ ok:true }));
app.get("/api/rows",(req,res)=>res.json({ version: state.version, rows: state.rows }));
app.get("/api/emails",(req,res)=>{
  const logs = fs.existsSync(EMAIL_LOG) ? fs.readFileSync(EMAIL_LOG,'utf-8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)) : [];
  res.json({ logs });
});

// MERGE upload: upsert by copy_uid
app.post("/api/upload", upload.single("file"), (req,res)=>{
  try{
    if (!req.file) return res.status(400).json({ error:"No file uploaded" });
    const wb = xlsx.readFile(req.file.path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const errors=[];
    const upserts=[];
    const seen=new Set();
    for (let i=0;i<rows.length;i++){
      const r=rows[i];
      const raw = {
        student_email: String(r.student_email||r.email||r.student||"").trim(),
        student_name : String(r.student_name||r.name||"").trim(),
        book_title   : String(r.book_title||r.title||"").trim(),
        book_code    : String(r.book_code||r.code||"").trim(),
        copy_uid     : String(r.copy_uid||r.copy||"").trim(),
        issued_at    : String(r.issued_at||r.issued||"").trim(),
        due_at       : String(r.due_at||r.due||"").trim(),
      };
      const rowNum=i+2;
      if (!raw.student_email || !validEmail(raw.student_email)) { errors.push(`Row ${rowNum}: invalid student_email`); continue; }
      if (!raw.copy_uid) { errors.push(`Row ${rowNum}: missing copy_uid`); continue; }
      const key=normCopy(raw.copy_uid);
      if (seen.has(key)) { errors.push(`Row ${rowNum}: duplicate copy_uid within file (${raw.copy_uid})`); continue; }
      seen.add(key);
      const issuedISO = toISODate(raw.issued_at) || raw.issued_at;
      const dueISO = toISODate(raw.due_at) || raw.due_at;
      if (!toISODate(raw.due_at)) { errors.push(`Row ${rowNum}: invalid due_at date`); continue; }

      upserts.push({ student_email:raw.student_email, student_name:raw.student_name, book_title:raw.book_title, book_code:raw.book_code,
        copy_uid:raw.copy_uid, issued_at:issuedISO, due_at:dueISO, status:"issued",
        _norm_email:normEmail(raw.student_email), _norm_copy:key });
    }
    if (errors.length) return res.status(400).json({ error:"Validation failed", details: errors });

    const index = new Map(state.rows.map((r,idx)=>[r._norm_copy, idx]));
    for (const r of upserts) {
      if (index.has(r._norm_copy)) {
        const i = index.get(r._norm_copy);
        state.rows[i] = { ...state.rows[i], ...r };
      } else {
        state.rows.push(r);
        index.set(r._norm_copy, state.rows.length-1);
      }
    }
    state.version += 1; saveLedger();
    broadcast("IMPORT", { rows: state.rows, version: state.version });
    res.json({ ok:true, version: state.version, count: state.rows.length });
  }catch(e){
    res.status(500).json({ error:"Failed to parse file", details: String(e) });
  }finally{
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
  }
});

// Manual add (strict) with upsert
app.post("/api/add", (req,res)=>{
  try{
    const r = req.body || {};
    const required = ["student_email","student_name","book_title","book_code","copy_uid","issued_at","due_at"];
    for (const k of required){ if(!r[k] || String(r[k]).trim()==="") return res.status(400).json({ error:`Missing ${k}` }); }
    if (!validEmail(r.student_email)) return res.status(400).json({ error:"Invalid student_email" });
    if (!toISODate(r.due_at)) return res.status(400).json({ error:"Invalid due_at date" });

    const row = {
      student_email: String(r.student_email).trim(),
      student_name : String(r.student_name).trim(),
      book_title   : String(r.book_title).trim(),
      book_code    : String(r.book_code).trim(),
      copy_uid     : String(r.copy_uid).trim(),
      issued_at    : toISODate(r.issued_at) || String(r.issued_at).trim(),
      due_at       : toISODate(r.due_at) || String(r.due_at).trim(),
      status       : "issued",
      _norm_email  : normEmail(r.student_email),
      _norm_copy   : normCopy(r.copy_uid)
    };
    const idx = state.rows.findIndex(x=>x._norm_copy===row._norm_copy);
    if (idx>=0) state.rows[idx] = { ...state.rows[idx], ...row };
    else state.rows.push(row);
    state.version += 1; saveLedger();
    broadcast("IMPORT", { rows: state.rows, version: state.version });
    res.json({ ok:true, version: state.version });
  }catch(e){
    res.status(500).json({ error:"Failed to add", details:String(e) });
  }
});

app.post("/api/load-sample",(req,res)=>{
  const sample=[
    { student_email:"srao22@bits.edu", student_name:"Sahil Rao", book_title:"Signals & Systems", book_code:"SIGSYS-3e", copy_uid:"SIGSYS-3e#00020", issued_at:"2025-07-28", due_at:"2025-12-15", status:"issued" },
    { student_email:"srao22@bits.edu", student_name:"Sahil Rao", book_title:"Digital Design", book_code:"DIGDES-2e", copy_uid:"DIGDES-2e#00010", issued_at:"2025-07-28", due_at:"2025-12-15", status:"issued" },
    { student_email:"aditi23@bits.edu", student_name:"Aditi Rao", book_title:"Linear Algebra", book_code:"LINALG-5e", copy_uid:"LINALG-5e#00052", issued_at:"2025-07-28", due_at:"2025-12-15", status:"issued" },
  ];
  state.rows = sample.map(r=>({...r, _norm_email:normEmail(r.student_email), _norm_copy:normCopy(r.copy_uid)}));
  state.version += 1; saveLedger();
  broadcast("IMPORT", { rows: state.rows, version: state.version });
  res.json({ ok:true, version: state.version, count: state.rows.length });
});

app.post("/api/return", (req,res)=>{
  const copy = normCopy(String(req.body.copy_uid||""));
  if (!copy) return res.status(400).json({ error:"copy_uid required" });
  let changed=false;
  state.rows = state.rows.map(r=>{
    if (r._norm_copy===copy && (r.status||"issued")==="issued"){ changed=true; return { ...r, status:"returned" }; }
    return r;
  });
  if (changed){ state.version += 1; saveLedger(); broadcast("RETURN", { uids:[copy], version: state.version }); }
  res.json({ ok:true, version: state.version });
});

app.post("/api/return-all", (req,res)=>{
  const email = normEmail(String(req.body.student_email||""));
  if (!email) return res.status(400).json({ error:"student_email required" });
  const uids=[];
  state.rows = state.rows.map(r=>{
    if (r._norm_email===email && (r.status||"issued")==="issued"){ uids.push(r._norm_copy); return { ...r, status:"returned" }; }
    return r;
  });
  if (uids.length){ state.version += 1; saveLedger(); broadcast("RETURN", { uids, version: state.version }); }
  res.json({ ok:true, version: state.version, count: uids.length });
});

app.post("/api/emails", (req,res)=>{
  const entries = Array.isArray(req.body.entries)? req.body.entries : [];
  const originId = req.body.originId || "";
  for (const e of entries) fs.appendFileSync(EMAIL_LOG, JSON.stringify(e)+"\n");

  const sendAll = async ()=>{
    if (!SMTP_URL) return;
    const transporter = nodemailer.createTransport(SMTP_URL);
    for (const e of entries) {
      try { await transporter.sendMail({ from: e.from||"library@bits-goa.ac.in", to: e.to, subject: e.subject, text: e.body }); } catch {}
    }
  };
  sendAll().catch(()=>{});

  broadcast("EMAILS_SENT", { entries, originId });
  res.json({ ok:true, count: entries.length });
});

app.post("/api/reset", (req,res)=>{
  const { confirm } = req.body || {};
  if (confirm !== "RESET") return res.status(400).json({ error:"Confirmation required. Send {confirm:'RESET'}" });
  state.rows = []; state.version += 1; saveLedger();
  try { fs.unlinkSync(EMAIL_LOG); } catch {}
  broadcast("RESET", { version: state.version });
  res.json({ ok:true, version: state.version });
});

let server;
if (SSL_CERT_PATH && SSL_KEY_PATH && fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH)) {
  const opts = { cert: fs.readFileSync(SSL_CERT_PATH), key: fs.readFileSync(SSL_KEY_PATH) };
  server = https.createServer(opts, app); console.log("HTTPS enabled");
} else {
  server = http.createServer(app);
}
const wss = new WebSocketServer({ server });
server.listen(PORT, ()=>console.log(`API on ${SSL_CERT_PATH?"https":"http"}://localhost:${PORT}`));
