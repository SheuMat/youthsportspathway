(function () {
  const KEY = 'ysp-admin';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const label = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  let password = '';
  let data = null;
  let show = 'all';

  const store = {
    get() { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } },
    set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
  };

  async function api(query) {
    const res = await fetch('/api/admin' + query, { headers: { Authorization: 'Bearer ' + password }, cache: 'no-store' });
    if (res.status === 401) throw new Error('unauthorised');
    if (!res.ok) throw new Error('failed');
    return res;
  }

  async function load() {
    data = await (await api('')).json();
    document.getElementById('login').hidden = true;
    document.getElementById('dash').hidden = false;

    document.getElementById('capacity').innerHTML = Object.entries(data.slots).map(([code, s]) => `
      <div class="session-card"><div class="session-card-header"><h3>${esc(s.label)} 5–6pm</h3></div>
      <div class="session-card-body"><div class="session-price">${s.taken} / ${s.capacity} <small>places taken</small></div></div></div>`).join('');

    const today = new Date().toISOString().slice(0, 10);
    const sel = document.getElementById('register-session');
    sel.innerHTML = data.sessions.map((s) => `<option value="${s.id}">${esc(label(s.date))} (${s.slot_code === 'mon' ? 'Monday' : 'Friday'})</option>`).join('');
    const next = data.sessions.find((s) => s.date >= today);
    if (next) sel.value = String(next.id);
    renderMembers();
  }

  function renderMembers() {
    const rows = data.members.filter((m) => show === 'all' || m.slots.includes(show));
    document.querySelector('#members tbody').innerHTML = rows.length ? rows.map((m) => `<tr>
      <td><strong>${esc(m.childName)}</strong></td><td>${esc(m.parentName)}</td>
      <td><a href="tel:${esc(m.phone)}">${esc(m.phone)}</a></td><td><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></td>
      <td>${esc(m.plan)}</td>
      <td>${esc(m.holdExpired ? 'abandoned' : m.status)}${m.notes ? `<br><small>${esc(m.notes)}</small>` : ''}</td>
      <td>${esc(m.paymentStatus)}</td><td>${esc(m.paymentDay)}${m.firstChargeDate ? `<br><small>from ${esc(m.firstChargeDate)}</small>` : ''}</td>
      <td>${esc(m.createdAt.slice(0, 10))}</td></tr>`).join('') : '<tr><td colspan="9">No members yet.</td></tr>';
  }

  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    password = document.getElementById('password').value;
    try { await load(); store.set(password); document.getElementById('login-error').textContent = ''; }
    catch (err) { document.getElementById('login-error').textContent = err.message === 'unauthorised' ? 'Incorrect password.' : 'Could not load bookings.'; }
  });

  document.getElementById('download').addEventListener('click', async () => {
    const id = document.getElementById('register-session').value;
    const res = await api('?register=' + encodeURIComponent(id));
    const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'register.csv';
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  document.querySelectorAll('[data-show]').forEach((btn) => btn.addEventListener('click', () => {
    show = btn.dataset.show;
    document.querySelectorAll('[data-show]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderMembers();
  }));

  password = store.get();
  if (password) load().catch(() => store.set(''));
})();
