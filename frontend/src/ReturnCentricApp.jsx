import React, { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || `${location.protocol}//${location.hostname}:3001`;
const PAGE_SIZE = 10;
const DEFAULT_META = { library_name: "BITS Goa Library", library_phone: "+91 832 555 0123", return_counter_hours: "Mon–Fri, 10:00–17:00" };
const toKey = (s) => (s||"").trim().toLowerCase();
const classNames = (...a) => a.filter(Boolean).join(" ");
const formatDate = (iso) => { try { const d = new Date(iso); return d.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});} catch { return iso; } };
const groupBy = (arr, key) => arr.reduce((m,x)=>{const k=x[key]; (m[k]=m[k]||[]).push(x); return m;},{});

const individualSubject = (row) => `Reminder: Return “${row.book_title}” (${row.copy_uid})`;
const individualBody = (row, meta) => `Hi ${row.student_name || row.student_email},\n\nThis is a gentle reminder to return the following book to ${meta.library_name}:\n• Title: ${row.book_title}\n• Copy ID: ${row.copy_uid}\n• Due date: ${formatDate(row.due_at)}\n\nYou can return it at the counter during ${meta.return_counter_hours}.\n\n— ${meta.library_name} (${meta.library_phone})`;
const digestSubject = () => `Reminder: Books due from your account`;
const digestBody = (items, student, meta) => {
  const lines = items.map((r)=>`• ${r.book_title} — Copy ID: ${r.copy_uid} — Due: ${formatDate(r.due_at)}`).join("\n");
  return `Hi ${student.name || student.email},\n\nThe following items are currently issued to your account:\n${lines}\n\nPlease return them during ${meta.return_counter_hours}.\n\n— ${meta.library_name} (${meta.library_phone})`;
};

const instanceId = Math.random().toString(36).slice(2);

export default function ReturnCentricApp(){
  const [rows,setRows]=useState([]);
  const [serverVersion,setServerVersion]=useState(0);
  const [tab,setTab]=useState("upload");

  const [searchStudent,setSearchStudent]=useState("");
  const [searchTitle,setSearchTitle]=useState("");
  const [onlyOverdue,setOnlyOverdue]=useState(false);
  const [hideReturned,setHideReturned]=useState(false);

  const [pageStudents,setPageStudents]=useState(1);
  const [pageBooks,setPageBooks]=useState(1);

  const [selection,setSelection]=useState(new Set());
  const [compose,setCompose]=useState(null);
  const [emailLogs,setEmailLogs]=useState([]);
  const [emailView,setEmailView]=useState("chrono");
  const [emailSearch,setEmailSearch]=useState("");
  const [pageEmail,setPageEmail]=useState(1);
  const [sending,setSending]=useState(false);

  const [manual,setManual]=useState({ student_email:"", student_name:"", book_title:"", book_code:"", copy_uid:"", issued_at:"", due_at:"" });

  useEffect(()=>{
    fetch(`${API_BASE}/api/rows`).then(r=>r.json()).then(j=>{ setRows(j.rows||[]); setServerVersion(j.version||0); }).catch(()=>{});
    fetch(`${API_BASE}/api/emails`).then(r=>r.json()).then(j=>setEmailLogs(j.logs||[])).catch(()=>{});
  },[]);

  useEffect(()=>{
    const scheme = location.protocol==="https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.hostname}:3001`);
    ws.onmessage=(ev)=>{
      try{
        const msg=JSON.parse(ev.data);
        if(msg.type==="IMPORT"){ setRows(msg.rows||[]); setServerVersion(msg.version||0); setSelection(new Set()); }
        else if(msg.type==="RETURN"){
          const uids=new Set(msg.uids||[]);
          setRows(prev=>prev.map(r=> uids.has(toKey(r.copy_uid)) ? {...r, status:"returned"} : r ));
          setServerVersion(msg.version||0);
        } else if (msg.type==="EMAILS_SENT"){
          if (msg.originId === instanceId) return; // dedupe
          setEmailLogs(prev=>[...(msg.entries||[]), ...prev]);
        } else if (msg.type==="RESET"){
          setRows([]); setEmailLogs([]); setServerVersion(msg.version||0);
        }
      }catch{}
    };
    return ()=>ws.close();
  },[]);

  const issuedOrReturned = rows; // keep returned visible

  const filteredByStudent = React.useMemo(()=>{
    const q = toKey(searchStudent);
    const list = !q ? issuedOrReturned : issuedOrReturned.filter(r => toKey(r.student_email).includes(q) || toKey(r.student_name).includes(q));
    return groupBy(hideReturned ? list.filter(r=>(r.status||"issued")==="issued") : list, "student_email");
  }, [issuedOrReturned, searchStudent, hideReturned]);

  const studentEntries = React.useMemo(()=>Object.entries(filteredByStudent),[filteredByStudent]);
  const studentPages = Math.max(1, Math.ceil(studentEntries.length / PAGE_SIZE));
  const pagedStudentEntries = React.useMemo(()=>{
    const start=(pageStudents-1)*PAGE_SIZE; return studentEntries.slice(start,start+PAGE_SIZE);
  }, [studentEntries, pageStudents]);

  const filteredByBook = React.useMemo(()=>{
    const q = toKey(searchTitle);
    let list = issuedOrReturned.filter(r => !q || toKey(r.book_title).includes(q) || toKey(r.book_code).includes(q) || toKey(r.copy_uid).includes(q));
    if (onlyOverdue) { const t=new Date(); list=list.filter(r=> new Date(r.due_at) < t && (r.status||"issued")==="issued"); }
    if (hideReturned) list=list.filter(r=>(r.status||"issued")==="issued");
    return list;
  }, [issuedOrReturned, searchTitle, onlyOverdue, hideReturned]);
  const bookPages = Math.max(1, Math.ceil(filteredByBook.length / PAGE_SIZE));
  const pagedBooks = React.useMemo(()=>{ const s=(pageBooks-1)*PAGE_SIZE; return filteredByBook.slice(s,s+PAGE_SIZE); }, [filteredByBook,pageBooks]);

  const normalizedEmailLogs = React.useMemo(()=>{
    return (emailLogs||[]).map(e=>({
      ...e,
      sent_at_ts: Date.parse(e.sent_at||"") || 0,
      to_key: toKey(e.to),
      books: Array.isArray(e.books)? e.books : []
    }));
  }, [emailLogs]);

  const emailLogSearchFilter = React.useMemo(()=>{
    const q = toKey(emailSearch);
    if (!q) return normalizedEmailLogs;
    const hasQ = (s) => toKey(s).includes(q);
    return normalizedEmailLogs.filter(e =>
      hasQ(e.to) || hasQ(e.name) || hasQ(e.subject) ||
      (e.books||[]).some(b => hasQ(b.book_title) || hasQ(b.copy_uid) || hasQ(b.student_email))
    );
  }, [normalizedEmailLogs, emailSearch]);

  const emailByStudent = React.useMemo(()=>{
    const groups = {};
    for (const e of emailLogSearchFilter) {
      const k = toKey(e.to);
      (groups[k] = groups[k] || { email: e.to, name: e.name || e.to, entries: [], latest: 0 }).entries.push(e);
      if (e.sent_at_ts > groups[k].latest) groups[k].latest = e.sent_at_ts;
    }
    return Object.values(groups).sort((a,b)=>b.latest-a.latest);
  }, [emailLogSearchFilter]);

  const emailByBook = React.useMemo(()=>{
    const m = new Map();
    for (const e of emailLogSearchFilter) {
      for (const b of (e.books||[])) {
        const key = toKey(b.copy_uid);
        if (!key) continue;
        const prev = m.get(key) || { copy_uid: b.copy_uid, book_title: b.book_title, send_count: 0, latest: 0, recipients: new Set() };
        prev.send_count += 1;
        prev.latest = Math.max(prev.latest, e.sent_at_ts);
        if (e.to) prev.recipients.add(e.to);
        if (!prev.book_title && b.book_title) prev.book_title = b.book_title;
        m.set(key, prev);
      }
    }
    return Array.from(m.values()).map(x=>({ ...x, recipients_count: x.recipients.size })).sort((a,b)=>b.latest-a.latest);
  }, [emailLogSearchFilter]);

  const emailPages = React.useMemo(()=>{
    const len = emailView==="chrono" ? emailLogSearchFilter.length : emailView==="byStudent" ? emailByStudent.length : emailByBook.length;
    return Math.max(1, Math.ceil(len / PAGE_SIZE));
  }, [emailView, emailLogSearchFilter, emailByStudent, emailByBook]);
  const pagedEmailData = React.useMemo(()=>{
    const start=(pageEmail-1)*PAGE_SIZE;
    if (emailView==="chrono") return emailLogSearchFilter.slice(start,start+PAGE_SIZE);
    if (emailView==="byStudent") return emailByStudent.slice(start,start+PAGE_SIZE);
    return emailByBook.slice(start,start+PAGE_SIZE);
  }, [emailView, emailLogSearchFilter, emailByStudent, emailByBook, pageEmail]);

  function togglePick(copy_uid){
    const next=new Set(selection); const k=toKey(copy_uid); next.has(k)?next.delete(k):next.add(k); setSelection(next);
  }
  async function markReturned(copy_uid){
    const key=(copy_uid||"").trim();
    await fetch(`${API_BASE}/api/return`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({copy_uid:key})});
  }
  async function returnAllForStudent(email){
    await fetch(`${API_BASE}/api/return-all`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({student_email:(email||"").trim()})});
  }
  async function loadSample(){ await fetch(`${API_BASE}/api/load-sample`,{method:"POST"}); }
  async function uploadExcel(e){
    const file = e?.target?.files?.[0]; if(!file) return;
    const fd=new FormData(); fd.append("file", file);
    const r=await fetch(`${API_BASE}/api/upload`,{method:"POST",body:fd});
    if(!r.ok){ const j=await r.json().catch(()=>({})); alert("Upload failed:\n"+(j.error||"Unknown")); }
  }
  async function addManual(){
    const r = await fetch(`${API_BASE}/api/add`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(manual)});
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ alert("Add failed:\n"+(j.error||"Unknown")); return; }
    setManual({ student_email:"", student_name:"", book_title:"", book_code:"", copy_uid:"", issued_at:"", due_at:"" });
  }
  async function resetAll(){
    const text = prompt("Type RESET to confirm clearing all server data (ledger + email logs).");
    if (text!=="RESET") return;
    await fetch(`${API_BASE}/api/reset`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ confirm:"RESET" }) });
  }

  function openIndividualEmail(row){
    setCompose({
      mode:"per_copy",
      recipients:[{ to:(row.student_email||"").trim(), name:row.student_name, payload:[row]}],
      previewIndex:0,
      subject:individualSubject(row),
      body:individualBody(row, DEFAULT_META),
    });
  }
  function openBulkEmail(mode){
    const picked = filteredByBook.filter(r=> selection.has(toKey(r.copy_uid)) && (r.status||"issued")==="issued");
    if(!picked.length) return;
    if(mode==="per_copy"){
      const recipients = picked.map(r=>({to:(r.student_email||"").trim(), name:r.student_name, payload:[r]}));
      setCompose({ mode, recipients, previewIndex:0, subject:individualSubject(picked[0]), body:individualBody(picked[0], DEFAULT_META) });
    } else {
      const byStudent = groupBy(picked,"student_email");
      const recipients = Object.entries(byStudent).map(([email,items])=>({to:(email||"").trim(), name:items[0]?.student_name||email, payload:items}));
      const first = recipients[0];
      setCompose({ mode, recipients, previewIndex:0, subject:digestSubject(), body:digestBody(first.payload,{name:first.name,email:first.to}, DEFAULT_META) });
    }
  }
  function openStudentDigestEmail(email){
    const items = issuedOrReturned.filter(r=> toKey(r.student_email)===toKey(email) && (r.status||"issued")==="issued");
    if(!items.length) return;
    const name = items[0]?.student_name || email;
    setCompose({ mode:"per_student", recipients:[{ to:(email||"").trim(), name, payload:items }], previewIndex:0, subject:digestSubject(), body:digestBody(items,{name,email}, DEFAULT_META) });
  }
  function updatePreview(idx){
    setCompose(c=>{
      if(!c) return c;
      const r=c.recipients[idx];
      if(c.mode==="per_copy") return {...c, previewIndex:idx, subject:individualSubject(r.payload[0]), body:individualBody(r.payload[0], DEFAULT_META)};
      return {...c, previewIndex:idx, subject:digestSubject(), body:digestBody(r.payload,{name:r.name,email:r.to}, DEFAULT_META)};
    });
  }
  async function sendEmails(){
    if(!compose || sending) return;
    setSending(true);
    const ts = new Date().toISOString();
    const entries = compose.recipients.map(r=>{
      const subj = compose.mode==="per_copy" ? individualSubject(r.payload[0]) : digestSubject();
      const bod  = compose.mode==="per_copy" ? individualBody(r.payload[0], DEFAULT_META) : digestBody(r.payload,{name:r.name,email:r.to}, DEFAULT_META);
      const books = compose.mode==="per_copy" ? [{ book_title:r.payload[0].book_title, copy_uid:r.payload[0].copy_uid, student_email:r.to }] : r.payload.map(it=>({ book_title:it.book_title, copy_uid:it.copy_uid, student_email:r.to }));
      return { to:r.to, name:r.name, subject:subj, body:bod, mode:compose.mode, sent_at:ts, books };
    });
    try{
      setEmailLogs(prev=>[...entries, ...prev]); // optimistic
      const res = await fetch(`${API_BASE}/api/emails`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ entries, originId: instanceId }) });
      if(!res.ok){ alert("Email log failed to save"); }
    } finally {
      setSending(false);
      setCompose(null);
      setSelection(new Set());
      setTab("emails");
    }
  }

  const TabButton = ({id,label}) => (<button onClick={()=>setTab(id)} className={classNames("px-4 py-2 rounded-2xl text-sm font-medium", tab===id ? "bg-indigo-600 text-white" : "bg-white text-gray-700 hover:bg-gray-100")}>{label}</button>);
  const Pager = ({page,pages,onPrev,onNext}) => (<div className="flex items-center justify-end gap-3 py-3 text-sm text-gray-700">
      <button className={classNames("px-3 py-1.5 rounded-xl", page<=1?"bg-gray-200 text-gray-500 cursor-not-allowed":"bg-white border hover:bg-gray-50")} disabled={page<=1} onClick={onPrev}>Prev</button>
      <span>Page <b>{page}</b> of <b>{pages}</b></span>
      <button className={classNames("px-3 py-1.5 rounded-xl", page>=pages?"bg-gray-200 text-gray-500 cursor-not-allowed":"bg-white border hover:bg-gray-50")} disabled={page>=pages} onClick={onNext}>Next</button>
  </div>);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="mx-auto max-w-7xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600"></div>
            <div>
              <h1 className="text-xl font-semibold">Return‑Centric Book Bank</h1>
              <p className="text-xs text-gray-500">Excel → Issued/Returned • Return & Mail • Email Log • Admin</p>
            </div>
          </div>
          <nav className="flex items-center gap-2">
            <TabButton id="upload" label="Upload / Admin" />
            <TabButton id="issued" label="Student‑wise" />
            <TabButton id="return" label="Book‑wise" />
            <TabButton id="emails" label="Email Log" />
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {tab==="upload" && (
          <section className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-white rounded-2xl shadow-sm p-6">
                <h2 className="text-lg font-semibold mb-2">Upload / Sync Excel (MERGE)</h2>
                <p className="text-sm text-gray-600 mb-4">Upload .xlsx / .csv with columns: <b>student_email, student_name, book_title, book_code, copy_uid, issued_at, due_at</b>. Uploads <b>merge/update</b> existing copies by <b>copy_uid</b> (no duplicates).</p>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={uploadExcel} />
                <div className="mt-3 flex items-center gap-3">
                  <button onClick={loadSample} className="px-4 py-2 rounded-2xl bg-gray-100 text-gray-700 font-medium">Load Sample</button>
                </div>
              </div>

              <div className="bg-white rounded-2xl shadow-sm p-6">
                <h3 className="text-md font-semibold mb-2">Manual add (strict fields)</h3>
                <div className="grid md:grid-cols-2 gap-3">
                  {["student_email","student_name","book_title","book_code","copy_uid","issued_at","due_at"].map(k=>(
                    <input key={k} className="w-full px-3 py-2 rounded-xl border" placeholder={k} value={manual[k]} onChange={e=>setManual(prev=>({...prev,[k]:e.target.value}))} />
                  ))}
                </div>
                <div className="mt-3">
                  <button onClick={addManual} className="px-4 py-2 rounded-2xl bg-indigo-600 text-white">Add entry</button>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="bg-white rounded-2xl shadow-sm p-6">
                <h3 className="text-sm font-semibold mb-2">Summary</h3>
                <ul className="text-sm text-gray-700 space-y-1">
                  <li>Total ledger rows: <b>{rows.length}</b></li>
                  <li>Server version: <b>{serverVersion}</b></li>
                </ul>
              </div>
              <div className="bg-white rounded-2xl shadow-sm p-6 border border-red-200">
                <h3 className="text-sm font-semibold mb-2 text-red-700">Reset (Danger Zone)</h3>
                <p className="text-xs text-gray-600 mb-3">Clears ledger and email logs on server. This is irreversible. Use before a new semester.</p>
                <button onClick={resetAll} className="px-4 py-2 rounded-2xl bg-red-600 text-white">Reset server data</button>
              </div>
            </div>
          </section>
        )}

        {tab==="issued" && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <input className="w-full md:w-96 px-4 py-2 rounded-2xl border focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Search by email, name…" value={searchStudent} onChange={e=>setSearchStudent(e.target.value)} />
              <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={hideReturned} onChange={e=>setHideReturned(e.target.checked)} />Hide returned</label>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {pagedStudentEntries.map(([email, items]) => (
                <div key={email} className="bg-white rounded-2xl shadow-sm p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-gray-900">{items[0]?.student_name || email}</h3>
                      <p className="text-sm text-gray-600">{email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="px-3 py-1.5 rounded-xl text-sm bg-indigo-50 text-indigo-700" onClick={()=>openStudentDigestEmail(email)}>Email student</button>
                      <button className="px-3 py-1.5 rounded-xl text-sm bg-emerald-600 text-white" onClick={()=>returnAllForStudent(email)}>Return all</button>
                    </div>
                  </div>
                  <ul className="divide-y">
                    {items.map((r) => (
                      <li key={r.copy_uid} className="py-3 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">{r.book_title} <span className="text-gray-400">({r.book_code})</span></p>
                          <p className="text-xs text-gray-500">Copy: {r.copy_uid} • Due {formatDate(r.due_at)}</p>
                          <div className="mt-1 text-xs">
                            {(r.status||"issued")==="returned" ? <span className="inline-block px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Returned</span> : <span className="inline-block px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">Issued</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button className="px-3 py-1.5 rounded-xl text-sm bg-indigo-50 text-indigo-700" onClick={()=>{ setTab("return"); setSearchTitle(r.book_title); }}>Return & Mail</button>
                          {(r.status||"issued")==="issued" && <button className="px-3 py-1.5 rounded-xl text-sm bg-emerald-600 text-white" onClick={()=>markReturned(r.copy_uid)}>Mark returned</button>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {studentEntries.length===0 && (<div className="text-sm text-gray-600">No matching students.</div>)}
            </div>
            {studentEntries.length>0 && (<Pager page={pageStudents} pages={studentPages} onPrev={()=>setPageStudents(p=>Math.max(1,p-1))} onNext={()=>setPageStudents(p=>Math.min(studentPages,p+1))} />)}
          </section>
        )}

        {tab==="return" && (
          <section className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <input className="w-full px-4 py-2 rounded-2xl border focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Filter by title/code/copy…" value={searchTitle} onChange={e=>setSearchTitle(e.target.value)} />
              <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={onlyOverdue} onChange={e=>setOnlyOverdue(e.target.checked)} />Only overdue (issued)</label>
              <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={hideReturned} onChange={e=>setHideReturned(e.target.checked)} />Hide returned</label>
            </div>
            <div className="flex items-center gap-2">
              <button className={classNames("px-4 py-2 rounded-2xl font-medium", selection.size ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-600 cursor-not-allowed")} disabled={!selection.size} onClick={()=>openBulkEmail("per_copy")}>Bulk Email — Per‑copy</button>
              <button className={classNames("px-4 py-2 rounded-2xl font-medium", selection.size ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-600 cursor-not-allowed")} disabled={!selection.size} onClick={()=>openBulkEmail("per_student")}>Bulk Email — Per‑student digest</button>
              {!!selection.size && (<span className="text-sm text-gray-600">Selected: {selection.size}</span>)}
            </div>
            <div className="overflow-hidden rounded-2xl border bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-4 py-3 text-left">Pick</th>
                    <th className="px-4 py-3 text-left">Copy UID</th>
                    <th className="px-4 py-3 text-left">Book Title</th>
                    <th className="px-4 py-3 text-left">Issued To</th>
                    <th className="px-4 py-3 text-left">Due</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedBooks.map((r) => (
                    <tr key={r.copy_uid} className="border-t">
                      <td className="px-4 py-3"><input type="checkbox" checked={selection.has(toKey(r.copy_uid))} onChange={()=>togglePick(r.copy_uid)} /></td>
                      <td className="px-4 py-3 font-mono">{r.copy_uid}</td>
                      <td className="px-4 py-3">{r.book_title} <span className="text-gray-400">({r.book_code})</span></td>
                      <td className="px-4 py-3"><div className="font-medium">{r.student_name}</div><div className="text-xs text-gray-500">{r.student_email}</div></td>
                      <td className="px-4 py-3">{formatDate(r.due_at)}</td>
                      <td className="px-4 py-3">{(r.status||"issued")==="returned" ? <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Returned</span> : <span className="px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">Issued</span>}</td>
                      <td className="px-4 py-3"><div className="flex items-center gap-2">{(r.status||"issued")==="issued" && <button className="px-3 py-1.5 rounded-xl text-sm bg-emerald-600 text-white" onClick={()=>markReturned(r.copy_uid)}>Mark Returned</button>}<button className="px-3 py-1.5 rounded-xl text-sm bg-indigo-50 text-indigo-700" onClick={()=>openIndividualEmail(r)}>Email</button></div></td>
                    </tr>
                  ))}
                  {pagedBooks.length===0 && (<tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No matching rows.</td></tr>)}
                </tbody>
              </table>
            </div>
            <Pager page={pageBooks} pages={bookPages} onPrev={()=>setPageBooks(p=>Math.max(1,p-1))} onNext={()=>setPageBooks(p=>Math.min(bookPages,p+1))} />
          </section>
        )}

        {tab==="emails" && (
          <section className="space-y-4">
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-semibold">Email Log</h3>
                <div className="flex items-center gap-2">
                  <input className="px-3 py-1.5 rounded-xl border text-sm" placeholder="Search name / email / subject / copy" value={emailSearch} onChange={e=>setEmailSearch(e.target.value)} />
                  <div className="flex items-center gap-2">
                    <button onClick={()=>setEmailView("chrono")} className={classNames("px-3 py-1.5 rounded-xl text-xs", emailView==="chrono"?"bg-indigo-600 text-white":"bg-white border text-gray-700")}>Chronological</button>
                    <button onClick={()=>setEmailView("byStudent")} className={classNames("px-3 py-1.5 rounded-xl text-xs", emailView==="byStudent"?"bg-indigo-600 text-white":"bg-white border text-gray-700")}>By student</button>
                    <button onClick={()=>setEmailView("byBook")} className={classNames("px-3 py-1.5 rounded-xl text-xs", emailView==="byBook"?"bg-indigo-600 text-white":"bg-white border text-gray-700")}>By book/copy</button>
                  </div>
                </div>
              </div>

              {emailView==="chrono" && (
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600"><tr><th className="px-4 py-2 text-left">Sent at</th><th className="px-4 py-2 text-left">To</th><th className="px-4 py-2 text-left">Subject</th><th className="px-4 py-2 text-left">Mode</th><th className="px-4 py-2 text-left">Books</th></tr></thead>
                  <tbody>
                    {pagedEmailData.map((e,i)=>(
                      <tr key={i} className="border-t">
                        <td className="px-4 py-2">{formatDate(e.sent_at)}</td>
                        <td className="px-4 py-2">{e.name} <span className="text-xs text-gray-500">({e.to})</span></td>
                        <td className="px-4 py-2">{e.subject}</td>
                        <td className="px-4 py-2">{e.mode}</td>
                        <td className="px-4 py-2">{(e.books||[]).map((b,bi)=>(<div key={bi} className="text-xs text-gray-600">{b.book_title} <span className="text-gray-400">({b.copy_uid})</span></div>))}</td>
                      </tr>
                    ))}
                    {emailLogSearchFilter.length===0 && (<tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">No emails sent yet.</td></tr>)}
                  </tbody>
                </table>
              )}

              {emailView==="byStudent" && (
                <div className="divide-y">
                  {pagedEmailData.map((g, idx)=>(
                    <div key={idx} className="p-4">
                      <div className="flex items-center justify-between">
                        <div><div className="font-semibold">{g.name}</div><div className="text-xs text-gray-500">{g.email}</div></div>
                        <div className="text-sm text-gray-600">Emails: <b>{g.entries.length}</b> • Latest: <b>{formatDate(g.latest)}</b></div>
                      </div>
                      <div className="mt-3 overflow-auto">
                        <table className="min-w-full text-sm">
                          <thead className="bg-gray-50 text-gray-600"><tr><th className="px-3 py-2 text-left">Sent at</th><th className="px-3 py-2 text-left">Subject</th><th className="px-3 py-2 text-left">Mode</th><th className="px-3 py-2 text-left">Books</th></tr></thead>
                          <tbody>
                            {g.entries.map((e,i)=>(
                              <tr key={i} className="border-t">
                                <td className="px-3 py-2">{formatDate(e.sent_at)}</td>
                                <td className="px-3 py-2">{e.subject}</td>
                                <td className="px-3 py-2">{e.mode}</td>
                                <td className="px-3 py-2">{(e.books||[]).map((b,bi)=>(<div key={bi} className="text-xs text-gray-600">{b.book_title} <span className="text-gray-400">({b.copy_uid})</span></div>))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                  {emailByStudent.length===0 && (<div className="px-4 py-8 text-center text-gray-500">No emails yet.</div>)}
                </div>
              )}

              {emailView==="byBook" && (
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600"><tr><th className="px-4 py-2 text-left">Copy UID</th><th className="px-4 py-2 text-left">Book Title</th><th className="px-4 py-2 text-left">Times emailed</th><th className="px-4 py-2 text-left">Recipients</th><th className="px-4 py-2 text-left">Latest</th></tr></thead>
                  <tbody>
                    {pagedEmailData.map((b,i)=>(
                      <tr key={i} className="border-t">
                        <td className="px-4 py-2 font-mono">{b.copy_uid}</td>
                        <td className="px-4 py-2">{b.book_title}</td>
                        <td className="px-4 py-2">{b.send_count}</td>
                        <td className="px-4 py-2">{b.recipients_count}</td>
                        <td className="px-4 py-2">{formatDate(b.latest)}</td>
                      </tr>
                    ))}
                    {emailByBook.length===0 && (<tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">No emails yet.</td></tr>)}
                  </tbody>
                </table>
              )}
            </div>
            <Pager page={pageEmail} pages={emailPages} onPrev={()=>setPageEmail(p=>Math.max(1,p-1))} onNext={()=>setPageEmail(p=>Math.min(emailPages,p+1))} />
          </section>
        )}

        {compose && (
          <div className="fixed inset-0 z-20 flex items-end md:items-center md:justify-center">
            <div className="absolute inset-0 bg-black/40" onClick={()=>setCompose(null)}></div>
            <div className="relative bg-white w-full md:w-[860px] max-h-[90vh] rounded-t-2xl md:rounded-2xl shadow-xl overflow-hidden">
              <div className="px-5 py-3 border-b flex items-center justify-between"><h3 className="font-semibold">Compose Email {compose.mode==="per_copy"?"(Per‑copy)":"(Per‑student digest)"}</h3><button className="text-gray-500" onClick={()=>setCompose(null)}>✕</button></div>
              <div className="grid md:grid-cols-3 gap-0">
                <div className="border-r max-h-[70vh] overflow-auto">
                  <div className="px-4 py-2 text-xs text-gray-500">Recipients ({compose.recipients.length})</div>
                  <ul className="divide-y">
                    {compose.recipients.map((r, idx) => (
                      <li key={idx} className={classNames("px-4 py-3 cursor-pointer", idx===compose.previewIndex?"bg-indigo-50":"hover:bg-gray-50")} onClick={()=>{
                        setCompose(c=>({ ...c, previewIndex: idx, subject: c.mode==="per_copy" ? individualSubject(r.payload[0]) : digestSubject(), body: c.mode==="per_copy" ? individualBody(r.payload[0], DEFAULT_META) : digestBody(r.payload,{name:r.name,email:r.to}, DEFAULT_META) }));
                      }}>
                        <div className="text-sm font-medium">{r.name}</div>
                        <div className="text-xs text-gray-500">{r.to}</div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="md:col-span-2 p-4 space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Subject</label>
                    <input className="w-full px-3 py-2 rounded-xl border" value={compose.subject} onChange={(e)=>setCompose({ ...compose, subject:e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Body</label>
                    <textarea rows={10} className="w-full px-3 py-2 rounded-xl border font-mono text-sm" value={compose.body} onChange={(e)=>setCompose({ ...compose, body:e.target.value })} />
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button className="px-4 py-2 rounded-2xl bg-gray-100" onClick={()=>setCompose(null)}>Cancel</button>
                    <button className={classNames("px-4 py-2 rounded-2xl text-white", sending?"bg-indigo-300 cursor-not-allowed":"bg-indigo-600")} disabled={sending} onClick={sendEmails}>Send</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
