import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BellRing,
  Check,
  ChevronDown,
  Clock3,
  FileUp,
  Inbox,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Mail,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "./api";
import { parseLeadText } from "./leads";
import type { EmailListResponse, EmailRecord, SenderConfig, User } from "./types";

type View = "scheduled" | "sent";

function localDateTime(minutesAhead: number): string {
  const date = new Date(Date.now() + minutesAhead * 60_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [authMessage, setAuthMessage] = useState("");
  const [view, setView] = useState<View>("scheduled");
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [senderConfig, setSenderConfig] = useState<SenderConfig | null>(null);
  const [isComposeOpen, setComposeOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [pageError, setPageError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("error")) setAuthMessage(params.get("error") ?? "Sign-in failed");
    if (params.get("slack") === "connected") setToast("Slack notifications are connected.");
    if (params.get("slack") === "disconnected") setToast("Slack notifications disconnected.");
    if (params.has("error") || params.has("slack")) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    api<User>("/api/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoadingUser(false));
  }, []);

  const refreshEmails = useCallback(async () => {
    setLoadingEmails(true);
    setPageError("");
    try {
      const params = new URLSearchParams({
        status: view,
        page: String(page),
        pageSize: "50",
      });
      if (search) params.set("search", search);
      const result = await api<EmailListResponse>(`/api/emails?${params.toString()}`);
      setEmails(result.emails);
      setTotal(result.total);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to load emails");
    } finally {
      setLoadingEmails(false);
    }
  }, [page, search, view]);

  useEffect(() => {
    if (!user) return;
    void refreshEmails();
    const timer = window.setInterval(() => void refreshEmails(), 10_000);
    return () => window.clearInterval(timer);
  }, [refreshEmails, user]);

  useEffect(() => {
    if (!user) return;
    api<SenderConfig>("/api/senders")
      .then(setSenderConfig)
      .catch((error: unknown) => setPageError(error instanceof Error ? error.message : "Unable to load senders"));
  }, [user]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sentCount = useMemo(
    () => emails.filter((email) => email.status === "sent").length,
    [emails],
  );

  async function handleLogout() {
    try {
      await api<void>("/auth/logout", { method: "POST" });
      setUser(null);
      setEmails([]);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to log out");
    }
  }

  async function disconnectSlack() {
    try {
      await api<void>("/api/slack", { method: "DELETE" });
      setUser((current) => current ? { ...current, slackConnection: null } : current);
      setToast("Slack notifications disconnected.");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to disconnect Slack");
    }
  }

  function runSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  if (loadingUser) {
    return <div className="full-screen-loading"><LoaderCircle className="spin" size={22} /> Loading your workspace</div>;
  }

  if (!user) {
    return (
      <main className="login-page">
        <div className="login-left">
          <a className="brand brand-light" href="/">
            <span className="brand-mark"><Send size={17} /></span>
            <span>reachinbox</span>
          </a>
          <div className="login-pitch">
            <div className="eyebrow"><span className="live-dot" /> EMAIL WORKFLOWS, IN FLOW</div>
            <h1>Make every<br />send count.</h1>
            <p>Thoughtful outreach, delivered right on time. Your email operations, all in one calm workspace.</p>
            <div className="pitch-card">
              <div className="pitch-card-icon"><Clock3 size={18} /></div>
              <div><strong>Right on schedule</strong><span>Persistent delivery backed by BullMQ</span></div>
              <Check size={17} className="pitch-check" />
            </div>
          </div>
          <div className="login-footer">Built for better conversations <span>✳</span></div>
        </div>
        <div className="login-right">
          <div className="login-panel">
            <div className="login-icon"><Mail size={21} /></div>
            <h2>Welcome to ReachInbox</h2>
            <p className="login-subtitle">Sign in to manage your email campaigns.</p>
            {authMessage && <div className="inline-alert">{authMessage}</div>}
            <a className="google-button" href="/auth/google">
              <GoogleMark />
              Continue with Google
              <ArrowUpRight size={16} />
            </a>
            <div className="secure-note"><ShieldCheck size={15} /> Secure sign-in powered by Google OAuth</div>
            <div className="login-divider"><span>YOUR WORKSPACE</span></div>
            <div className="workspace-preview">
              <div className="mini-avatar">R</div>
              <div><strong>ReachInbox Scheduler</strong><span>Automate your next great conversation</span></div>
              <ChevronDown size={16} />
            </div>
          </div>
          <div className="login-legal">By continuing, you agree to our Terms of Service and Privacy Policy.</div>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark"><Send size={17} /></span>
          <span>reachinbox</span>
        </a>
        <div className="workspace-select">
          <div className="workspace-avatar">R</div>
          <div className="workspace-copy"><strong>Outbox workspace</strong><span>Free plan</span></div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <button className={`nav-item ${view === "scheduled" ? "active" : ""}`} onClick={() => { setView("scheduled"); setPage(1); }}>
          <LayoutDashboard size={17} /> Overview
        </button>
        <button className={`nav-item ${view === "scheduled" ? "active-sub" : ""}`} onClick={() => { setView("scheduled"); setPage(1); }}>
          <Clock3 size={17} /> Scheduled
          {view === "scheduled" && <span className="nav-count">{total}</span>}
        </button>
        <button className={`nav-item ${view === "sent" ? "active-sub" : ""}`} onClick={() => { setView("sent"); setPage(1); }}>
          <Inbox size={17} /> Sent emails
          {view === "sent" && <span className="nav-count">{total}</span>}
        </button>
        <div className="sidebar-spacer" />
        <div className="sidebar-promo">
          <div className="promo-icon"><Sparkles size={16} /></div>
          <strong>Good things take timing.</strong>
          <p>Let your messages find their moment.</p>
          <div className="promo-art"><span /><span /><span /><span /><span /><span /><span /></div>
        </div>
        <div className="sidebar-bottom">
          <a className="nav-item queue-link" href="/admin/queues" target="_blank" rel="noreferrer">
            <Settings2 size={17} /> Queue dashboard <ArrowUpRight size={14} />
          </a>
          <div className="sidebar-user">
            <Avatar user={user} />
            <div className="user-copy"><strong>{user.name}</strong><span>{user.email}</span></div>
            <button className="icon-button logout-button" title="Log out" aria-label="Log out" onClick={handleLogout}><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{view === "scheduled" ? "Scheduled emails" : "Sent emails"}</strong></div>
          <div className="topbar-actions">
            <div className="connection-pill"><span className="live-dot" /> Queue active</div>
            <button className="icon-button notification-button" aria-label="Notifications"><BellRing size={17} /></button>
            <div className="topbar-avatar"><Avatar user={user} /></div>
          </div>
        </header>

        <section className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow muted-eyebrow">YOUR OUTREACH</div>
              <h1>{view === "scheduled" ? "Email schedule" : "Sent emails"}</h1>
              <p>{view === "scheduled" ? "A clear view of every message on its way." : "Every message that has made it to the inbox."}</p>
            </div>
            <button className="primary-button" onClick={() => setComposeOpen(true)}><Plus size={17} /> Compose new email</button>
          </div>

          <div className="metric-row">
            <div className="metric-card">
              <div className="metric-symbol scheduled-symbol"><Clock3 size={17} /></div>
              <div><span>{view === "scheduled" ? "In the queue" : "Showing messages"}</span><strong>{total.toLocaleString()}</strong></div>
              <div className="metric-note"><span className="live-dot" /> Live</div>
            </div>
            <div className="metric-card">
              <div className="metric-symbol sent-symbol"><Check size={17} /></div>
              <div><span>Sent this view</span><strong>{sentCount.toLocaleString()}</strong></div>
              <div className="metric-note">Last 50</div>
            </div>
            <div className="metric-card slack-metric">
              <div className="metric-symbol slack-symbol"><BellRing size={17} /></div>
              <div><span>Rate limit alerts</span><strong>{user.slackConnection ? "Connected" : "Not connected"}</strong></div>
              {user.slackConnection
                ? <button className="text-button" onClick={disconnectSlack}>Disconnect</button>
                : <a className="text-button" href="/auth/slack">Connect Slack <ArrowUpRight size={13} /></a>}
            </div>
          </div>

          <div className="list-panel">
            <div className="list-toolbar">
              <div className="tab-group">
                <button className={view === "scheduled" ? "tab active-tab" : "tab"} onClick={() => { setView("scheduled"); setPage(1); }}>
                  <Clock3 size={15} /> Scheduled <span>{view === "scheduled" ? total : ""}</span>
                </button>
                <button className={view === "sent" ? "tab active-tab" : "tab"} onClick={() => { setView("sent"); setPage(1); }}>
                  <Inbox size={15} /> Sent <span>{view === "sent" ? total : ""}</span>
                </button>
              </div>
              <form className="search-box" onSubmit={runSearch}>
                <Search size={16} />
                <input aria-label="Search emails" placeholder="Search emails..." value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
                {searchInput && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setSearchInput(""); setSearch(""); setPage(1); }}><X size={14} /></button>}
              </form>
            </div>

            {pageError && <div className="inline-alert page-alert">{pageError}</div>}

            <div className="table-heading">
              <span className="table-title"><span className="table-title-dot" /> {view === "scheduled" ? "UPCOMING EMAILS" : "DELIVERY HISTORY"}</span>
              <span className="table-summary">{view === "scheduled" ? "Scheduled and sending" : "Sent and failed"}</span>
            </div>
            <div className="email-table-wrap">
              <table className="email-table">
                <thead>
                  <tr>
                    <th><span className="checkbox" /></th>
                    <th>RECIPIENT</th>
                    <th>SUBJECT</th>
                    <th>{view === "scheduled" ? "SCHEDULED FOR" : "SENT AT"}</th>
                    <th>STATUS</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {loadingEmails ? (
                    <tr><td colSpan={6}><div className="table-state"><LoaderCircle className="spin" size={20} /> Loading your emails...</div></td></tr>
                  ) : emails.length === 0 ? (
                    <tr><td colSpan={6}><div className="table-state empty-state"><div className="empty-icon"><Mail size={22} /></div><strong>{search ? "No matching emails" : view === "scheduled" ? "Your queue is clear" : "No sent emails yet"}</strong><span>{search ? "Try a different search term." : view === "scheduled" ? "Compose an email and it will appear here." : "Messages will show here once they're sent."}</span>{view === "scheduled" && <button className="secondary-button" onClick={() => setComposeOpen(true)}><Plus size={15} /> Schedule an email</button>}</div></td></tr>
                  ) : emails.map((email) => (
                    <EmailRow key={email.id} email={email} view={view} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              <span>Showing <strong>{emails.length ? (page - 1) * 50 + 1 : 0}–{Math.min(page * 50, total)}</strong> of <strong>{total}</strong> emails</span>
              <div className="pagination">
                <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(current - 1, 1))}>Previous</button>
                <button className="page-number">{page}</button>
                <button disabled={page * 50 >= total} onClick={() => setPage((current) => current + 1)}>Next</button>
              </div>
            </div>
          </div>

          <div className="bottom-note"><ShieldCheck size={14} /> Your schedule is persisted securely and survives service restarts.</div>
        </section>
      </main>

      {toast && <div className="toast"><Check size={17} /> {toast}</div>}
      {isComposeOpen && (
        <ComposeModal
          senderConfig={senderConfig}
          onClose={() => setComposeOpen(false)}
          onScheduled={(count) => {
            setComposeOpen(false);
            setView("scheduled");
            setPage(1);
            setSearch("");
            setSearchInput("");
            setToast(`${count} email${count === 1 ? "" : "s"} added to your schedule.`);
            void refreshEmails();
          }}
        />
      )}
    </div>
  );
}

function Avatar({ user }: { user: User }) {
  return user.avatar
    ? <img className="avatar" src={user.avatar} alt="" referrerPolicy="no-referrer" />
    : <span className="avatar avatar-fallback">{user.name.slice(0, 1).toUpperCase()}</span>;
}

function EmailRow({ email, view }: { email: EmailRecord; view: View }) {
  const statusLabel = email.status === "sending" ? "Sending" : email.status;
  return (
    <tr>
      <td><span className="checkbox" /></td>
      <td><div className="recipient-cell"><span className="recipient-avatar">{email.recipient.slice(0, 1).toUpperCase()}</span><div><strong>{email.recipient}</strong><span>From {email.senderEmail}</span></div></div></td>
      <td><span className="subject-cell" title={email.subject}>{email.subject}</span></td>
      <td><span className="date-cell">{formatDate(view === "sent" && email.sentAt ? email.sentAt : email.scheduledAt)}</span></td>
      <td><span className={`status-badge ${email.status}`}><span />{statusLabel}</span>{email.error && <span className="row-error" title={email.error}>Delivery error</span>}</td>
      <td><button className="row-more" aria-label={`Details for ${email.recipient}`}>···</button></td>
    </tr>
  );
}

function ComposeModal({
  senderConfig,
  onClose,
  onScheduled,
}: {
  senderConfig: SenderConfig | null;
  onClose: () => void;
  onScheduled: (count: number) => void;
}) {
  const [senderEmail, setSenderEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [leadText, setLeadText] = useState("");
  const [startAt, setStartAt] = useState(localDateTime(5));
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const parsedLeads = useMemo(() => parseLeadText(leadText), [leadText]);
  const recipients = parsedLeads.recipients;

  useEffect(() => {
    if (!senderConfig) return;
    setSenderEmail(senderConfig.senders[0]?.email ?? "");
    setHourlyLimit(senderConfig.defaultHourlyLimit);
    setDelaySeconds(senderConfig.minDelayBetweenEmailsMs / 1000);
  }, [senderConfig]);

  async function uploadLeads(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const fileExtension = file.name.split(".").pop()?.toLowerCase();
    if (!["csv", "txt"].includes(fileExtension ?? "")) {
      setError("Choose a CSV or TXT file.");
      event.target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Files must be 5 MB or smaller.");
      event.target.value = "";
      return;
    }
    try {
      setLeadText(await file.text());
      setError("");
    } catch {
      setError("Could not read that file. Please try a CSV or text file.");
    } finally {
      event.target.value = "";
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!senderEmail) {
      setError("Configure at least one SMTP sender before scheduling email.");
      return;
    }
    if (recipients.length === 0) {
      setError("Add at least one valid email address.");
      return;
    }
    if (!startAt || Number.isNaN(new Date(startAt).getTime())) {
      setError("Choose a valid start time.");
      return;
    }
    setSubmitting(true);
    try {
      const requestBody = JSON.stringify({
        senderEmail,
        subject,
        body,
        recipients,
        startAt: new Date(startAt).toISOString(),
        delayMs: Math.round(delaySeconds * 1000),
        hourlyLimit,
      });
      if (idempotencyRef.current?.fingerprint !== requestBody) {
        idempotencyRef.current = { fingerprint: requestBody, key: crypto.randomUUID() };
      }
      await api("/api/emails", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyRef.current.key },
        body: requestBody,
      });
      onScheduled(recipients.length);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to schedule emails");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-title">
        <header className="modal-header">
          <div><div className="eyebrow muted-eyebrow">NEW CAMPAIGN</div><h2 id="compose-title">Compose email</h2><p>Set up your message and choose when it should land.</p></div>
          <button className="icon-button" aria-label="Close compose dialog" onClick={onClose}><X size={18} /></button>
        </header>
        <form onSubmit={submit}>
          <div className="modal-body">
            {error && <div className="inline-alert">{error}</div>}
            <label className="field-label">From sender</label>
            <select className="text-input" value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} required>
              {senderConfig?.senders.length ? senderConfig.senders.map((sender) => <option value={sender.email} key={sender.email}>{sender.name} · {sender.email}</option>) : <option value="">No sender configured</option>}
            </select>

            <label className="field-label" htmlFor="lead-file">Email leads <span>CSV or TXT</span></label>
            <label htmlFor="lead-file" className="upload-zone">
              <span className="upload-icon"><FileUp size={19} /></span>
              <span><strong>Choose a file</strong> or drop it here<small>We’ll detect and deduplicate email addresses.</small></span>
              <ArrowDownToLine size={16} />
            </label>
            <input id="lead-file" className="visually-hidden" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={uploadLeads} />
            <textarea className="text-input lead-textarea" placeholder="Or paste email addresses here: alex@example.com, sam@example.com" value={leadText} onChange={(event) => setLeadText(event.target.value)} rows={3} />
            <div className="lead-count">
              <span><span className="count-dot" /> {recipients.length} valid email{recipients.length === 1 ? "" : "s"} detected</span>
              <span>{parsedLeads.invalidCount > 0 ? `${parsedLeads.invalidCount} invalid skipped` : `${parsedLeads.duplicatesRemoved} duplicates removed`}</span>
            </div>
            {recipients.length > 0 && <div className="recipient-preview">{recipients.slice(0, 4).map((recipient) => <span key={recipient}>{recipient}</span>)}{recipients.length > 4 && <span>+{recipients.length - 4} more</span>}</div>}

            <label className="field-label" htmlFor="subject">Subject</label>
            <input id="subject" className="text-input" required maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="A thoughtful subject line" />
            <label className="field-label" htmlFor="body">Message</label>
            <textarea id="body" className="text-input body-textarea" required value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write your email here..." rows={5} />

            <div className="schedule-fields">
              <div><label className="field-label" htmlFor="start-at">Start sending</label><input id="start-at" className="text-input" required type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} /></div>
              <div><label className="field-label" htmlFor="delay">Delay between emails <span>seconds</span></label><input id="delay" className="text-input" type="number" min="0" max="86400" step="0.5" value={delaySeconds} onChange={(event) => setDelaySeconds(Number(event.target.value))} /></div>
              <div><label className="field-label" htmlFor="hourly-limit">Emails per hour <span>per sender</span></label><input id="hourly-limit" className="text-input" type="number" min="1" max="100000" value={hourlyLimit} onChange={(event) => setHourlyLimit(Number(event.target.value))} /></div>
            </div>
            <div className="throttle-note"><ShieldCheck size={15} /> System minimum is {((senderConfig?.minDelayBetweenEmailsMs ?? 2000) / 1000).toFixed(1)} seconds between sends. Hourly limits are shared safely across workers.</div>
          </div>
          <footer className="modal-footer">
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={submitting || !recipients.length}>
              {submitting ? <><LoaderCircle className="spin" size={16} /> Scheduling…</> : <><Send size={15} /> Schedule {recipients.length || ""} email{recipients.length === 1 ? "" : "s"}</>}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" width="18" height="18">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" transform="translate(0 3)" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.27 5.48-4.78 7.18l7.73 6C44.4 37.97 46.98 31.95 46.98 24.55Z" transform="translate(0 -3)" />
      <path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19a23.9 23.9 0 0 0 0 21.56l7.98-6.19Z" transform="translate(0 3)" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.8l-7.73-6c-2.14 1.44-4.89 2.3-8.17 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" transform="translate(0 -3)" />
    </svg>
  );
}

export default App;
