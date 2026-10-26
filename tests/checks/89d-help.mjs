// Plan 8 — the Help button and its in-page Help dialog. The dialog is STATIC markup (no user data reaches it), so the checks read the
// real DOM: toolbar placement (right after Theme), showModal() on click, the six sections, the collector command with its Copy button,
// the badge legend built from the real .badge.q-* classes with QUALITY_LABEL texts, the dot legend, the links to the full guide and the
// README (target=_blank rel=noopener), and the close paths — Close button, Esc (a REAL key press → native cancel → 'close'), a click on
// the backdrop (event target === the dialog) — each returning focus to #help-btn. The `?` key toggles it when focus is not in a text
// field (a real key press on <body> opens; the same press inside the hub search box does not). Print media hides the dialog and the button.
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  // the dialog's 'close' event is a queued task: arm a listener in the page, act from Node (a real key press / mouse click), then await it there
  const armClose = () => page.evaluate(() => { window.__helpClosed = new Promise(r => document.getElementById('help-modal').addEventListener('close', () => r(true), { once: true })); });
  const waitClose = () => page.evaluate(() => Promise.race([window.__helpClosed, new Promise(r => setTimeout(() => r('timeout'), 1500))]));
  try {
    // (a) the toolbar button — right after Theme, inside .top-actions, an accessible dialog trigger
    const btn = await page.evaluate(() => {
      const b = document.getElementById('help-btn'), t = document.getElementById('theme-toggle');
      return { exists: !!b, afterTheme: !!b && !!t && t.nextElementSibling === b, inToolbar: !!b && !!b.closest('.top-actions'), text: b ? b.textContent : '',
        haspopup: b ? b.getAttribute('aria-haspopup') : null, controls: b ? b.getAttribute('aria-controls') : null, isBtn: !!b && b.classList.contains('btn') && b.classList.contains('small') };
    });
    ok('help (Plan 8): #help-btn is a .btn.small in the toolbar right after #theme-toggle, text matches /Help/, aria-haspopup="dialog", aria-controls="help-modal"',
      btn.exists && btn.afterTheme && btn.inToolbar && /Help/.test(btn.text) && btn.haspopup === 'dialog' && btn.controls === 'help-modal' && btn.isBtn, JSON.stringify(btn));

    // (b) click → showModal(); the six sections; the collector command; the badge + dot legends; the two links
    const opened = await page.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      document.getElementById('help-btn').click();
      const dlg = document.getElementById('help-modal');
      if (!dlg) return { open: false };
      const q = (s) => [...dlg.querySelectorAll(s)];
      return {
        open: dlg.open, modal: dlg.matches(':modal'), labelledby: dlg.getAttribute('aria-labelledby'), title: (dlg.querySelector('#help-title') || {}).textContent,
        head: !!dlg.querySelector('.modal-head #help-title') && !!dlg.querySelector('.modal-head .modal-close'),
        heads: q('h3').map(h => h.textContent.trim()),
        cmd: (dlg.querySelector('#help-cmd') || {}).textContent, copyBtn: (dlg.querySelector('#help-copy') || {}).textContent,
        badges: q('.badge').filter(b => /\bq-/.test(b.className)).map(b => [b.className.replace(/\s*badge\s*/, '').trim(), b.textContent]),
        ql: QUALITY_LABEL,
        dots: ['ok', 'warn', 'off'].map(k => !!dlg.querySelector('.dot.' + k)), dotSized: q('.dot').every(d => d.getBoundingClientRect().width >= 6),
        fixRows: q('dl.help-fix dt').length,
        links: q('a[href]').map(a => ({ href: a.getAttribute('href'), rel: a.rel, target: a.target })),
        text: dlg.textContent,
        pricesDate: (dlg.querySelector('#help-prices-date') || {}).textContent, verifiedOn: PRICES_VERIFIED_ON,
        pricesPara: (h => h && h.nextElementSibling && h.nextElementSibling.tagName === 'P' ? h.nextElementSibling.textContent : null)(q('h3').find(h => h.textContent.trim() === 'How prices work')),
        startHere: (h => h && h.nextElementSibling && h.nextElementSibling.tagName === 'OL' ? h.nextElementSibling.textContent : null)(q('h3').find(h => h.textContent.trim() === 'Start here')),
        numbers: (h => h && h.nextElementSibling && h.nextElementSibling.tagName === 'UL' ? [...h.nextElementSibling.children].map(li => ({ tag: li.tagName, lead: li.firstElementChild && li.firstElementChild.tagName === 'B' ? li.firstElementChild.textContent : null, text: li.textContent })) : null)(q('h3').find(h => h.textContent.trim() === 'Where the numbers come from')),
      };
    });
    ok('help (Plan 8): click opens the dialog with showModal() (open + :modal), aria-labelledby → #help-title "Help" inside the same .modal-head + .modal-close as the connector modal',
      opened.open === true && opened.modal === true && opened.labelledby === 'help-title' && opened.title === 'Help' && opened.head, JSON.stringify({ open: opened.open, modal: opened.modal, labelledby: opened.labelledby, title: opened.title, head: opened.head }));
    const HEADS = ['Start here', 'What the badges mean', 'Where the numbers come from', 'How prices work', 'If something looks wrong', 'Keyboard', 'More'];
    ok('help (Plan 8 + T3b): the seven <h3> sections in order — Start here / What the badges mean / Where the numbers come from / How prices work / If something looks wrong / Keyboard / More',
      JSON.stringify(opened.heads) === JSON.stringify(HEADS), JSON.stringify(opened.heads));
    ok('help (Plan 8): Start here carries the collector command in <code id="help-cmd"> with a "Copy" button and names Validate & connect, the Admin key path and the chat-app exports',
      opened.cmd === 'node docs/tools/ai-usage-collector.mjs' && opened.copyBtn === 'Copy' && /Validate & connect/.test(opened.text) && /Admin key/.test(opened.text) && /ChatGPT/.test(opened.text) && /Takeout/.test(opened.text) && /Imports/.test(opened.text),
      JSON.stringify({ cmd: opened.cmd, copyBtn: opened.copyBtn }));
    // Plan 9 B7: the collector also finds Cowork and the Plan 9 coding tools — Start here says so, by name
    ok('help (Plan 9 B7): Start here says the collector also finds Cowork (the Claude desktop app\'s agent sessions) and names the Plan 9 coding tools it discovers — OpenCode, Goose, Devin CLI, Kilo Code, Amp, Zed',
      typeof opened.startHere === 'string' && /Cowork/.test(opened.startHere) && ['OpenCode', 'Goose', 'Devin', 'Kilo Code', 'Amp', 'Zed'].every(t => opened.startHere.includes(t)), JSON.stringify(opened.startHere));
    // Plan 9 B7: "Where the numbers come from" opens with one line per honesty class — exact / estimated / validate-only / link-only / experimental, each a <li> led by a <b>
    const leads = (opened.numbers || []).map(i => i.lead);
    ok('help (Plan 9 B7): "Where the numbers come from" lists Exact / Estimated / Validate-only / Link-only / Experimental — one <li> each, in that order, each led by a <b>; the experimental line names Z.ai and MiniMax and says the figures never feed rows, billed amounts or totals; the cost rules follow',
      JSON.stringify(leads.slice(0, 5)) === JSON.stringify(['Exact', 'Estimated', 'Validate-only', 'Link-only', 'Experimental']) && leads.filter(l => ['Exact', 'Estimated', 'Validate-only', 'Link-only', 'Experimental'].includes(l)).length === 5
      && (opened.numbers || []).every(i => i.tag === 'LI') && /Z\.ai/.test(opened.numbers[4].text) && /MiniMax/.test(opened.numbers[4].text) && /never/.test(opened.numbers[4].text) && /totals/.test(opened.numbers[4].text)
      && /4 characters per token/.test(opened.numbers[1].text) && /est\./.test(opened.numbers[1].text) && leads.includes('API-equivalent cost') && leads.includes('Actual billed'), JSON.stringify(leads));

    const wantBadges = [['q-exact', 'exact'], ['q-estimated', 'estimated'], ['q-validate', 'validate-only'], ['q-none', 'no data']];
    ok('help (Plan 8): badge legend = the four real .badge.q-* spans with the QUALITY_LABEL texts (exact / estimated / validate-only / no data), plus the green-amber-gray dot legend (dots sized) with the 7-day rule',
      JSON.stringify(opened.badges) === JSON.stringify(wantBadges) && wantBadges.every(([k, t]) => opened.ql[k.slice(2)] === t) && opened.dots.every(Boolean) && opened.dotSized
        && /4 characters per token/.test(opened.text) && /more than 7 days/.test(opened.text), JSON.stringify({ badges: opened.badges, ql: opened.ql, dots: opened.dots, dotSized: opened.dotSized }));
    ok('help (Plan 8): cost rules name API-equivalent cost (list price, not an invoice), Actual billed (vendors that report money), est. rows never mixing silently, local runners $0, unpriced models named in a notice',
      /API-equivalent cost/.test(opened.text) && /not an invoice/.test(opened.text) && /Actual billed/.test(opened.text) && /est\./.test(opened.text) && /\$0/.test(opened.text) && /notice/.test(opened.text), '');
    ok('help (Plan 10 T3b): "How prices work" is one paragraph — the resolution order in plain words (lowercased + normalised id, a retired id priced as its successor, a platform override beats the vendor row, first matching row, the Unknown-model fallback), the bundled set\'s verified date filled from PRICES_VERIFIED_ON (#help-prices-date), how to edit (the API price list, stored in this browser, "user" pill), what a platform override is ("wins for")',
      typeof opened.pricesPara === 'string' && /normalised/.test(opened.pricesPara) && /successor/.test(opened.pricesPara) && /platform override/.test(opened.pricesPara) && /first matching/.test(opened.pricesPara) && /Unknown model/.test(opened.pricesPara)
      && /verified on /.test(opened.pricesPara) && opened.pricesDate === opened.verifiedOn && /^\d{4}-\d{2}-\d{2}$/.test(opened.pricesDate || '') && /API price list/.test(opened.pricesPara) && /this browser/.test(opened.pricesPara) && /wins for/.test(opened.pricesPara) && opened.pricesPara.length < 1200,
      JSON.stringify({ pricesDate: opened.pricesDate, verifiedOn: opened.verifiedOn, para: opened.pricesPara }));
    ok('help (Plan 8): troubleshooting is a six-row <dl class="help-fix"> — Not running at 127.0.0.1:11436, Token rejected + collector.token, Ollama CORS + OLLAMA_ORIGINS, Azure/Vertex token expired, folder picker, numbers changed after an update',
      opened.fixRows === 6 && /Not running at/.test(opened.text) && /127\.0\.0\.1:11436/.test(opened.text) && /Token rejected/.test(opened.text) && /collector\.token/.test(opened.text) && /OLLAMA_ORIGINS/.test(opened.text)
        && /token expired/.test(opened.text) && /folder picker/i.test(opened.text) && /re-scan/i.test(opened.text), JSON.stringify({ fixRows: opened.fixRows }));
    ok('help (Plan 8): Keyboard section — Esc closes any dialog, Enter on a hub card drills down, ✕ hides a card ("N hidden — show" restores), ▾ collapses a section',
      /Esc/.test(opened.text) && /Enter/.test(opened.text) && /✕/.test(opened.text) && /hidden — show/.test(opened.text) && /▾/.test(opened.text), '');
    const guide = opened.links.find(l => l.href === 'docs/user-guide.html'), readme = opened.links.find(l => l.href === 'README.md');
    ok('help (Plan 8): More — "Full user guide" → docs/user-guide.html and "README" → README.md, both target=_blank rel=noopener, with the note that they open from the repository folder or the collector-served page',
      !!guide && guide.target === '_blank' && /\bnoopener\b/.test(guide.rel) && !!readme && readme.target === '_blank' && /\bnoopener\b/.test(readme.rel) && /collector-served page/.test(opened.text), JSON.stringify(opened.links));

    // (g) Copy: clipboard stubbed → the command is written, the button reads "Copied" for 1.5 s, then "Copy" again
    const copied = await page.evaluate(async () => {
      let written = null;
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { written = t; } } });
      try {
        document.getElementById('help-copy').click();
        await new Promise(r => setTimeout(r, 50));
        const during = document.getElementById('help-copy').textContent;
        await new Promise(r => setTimeout(r, 1700));
        return { written, during, after: document.getElementById('help-copy').textContent };
      } finally { delete navigator.clipboard; if (desc) Object.defineProperty(Navigator.prototype, 'clipboard', desc); }
    });
    ok('help (Plan 8): Copy writes the collector command to the clipboard, flips to "Copied" and reads "Copy" again after 1.5 s',
      copied.written === 'node docs/tools/ai-usage-collector.mjs' && copied.during === 'Copied' && copied.after === 'Copy', JSON.stringify(copied));
    const noClip = await page.evaluate(async () => {
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      try { document.getElementById('help-copy').click(); await new Promise(r => setTimeout(r, 50)); return { text: document.getElementById('help-copy').textContent, open: document.getElementById('help-modal').open }; }
      finally { delete navigator.clipboard; if (desc) Object.defineProperty(Navigator.prototype, 'clipboard', desc); }
    });
    ok('help (Plan 8): without a clipboard API the Copy button fails silently (still "Copy", dialog still open, no page error)', noClip.text === 'Copy' && noClip.open === true, JSON.stringify(noClip));

    // (c) Esc — a REAL key press: native cancel → close → focus back on #help-btn
    await armClose();
    await page.keyboard.press('Escape');
    const escClosed = await waitClose();
    const esc = await page.evaluate(async (closed) => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return { closed, open: document.getElementById('help-modal').open, focus: document.activeElement && document.activeElement.id }; }, escClosed);
    ok('help (Plan 8): Esc closes the dialog and focus returns to #help-btn', esc.closed === true && esc.open === false && esc.focus === 'help-btn', JSON.stringify(esc));

    // Close button likewise
    const viaClose = await page.evaluate(async () => {
      document.getElementById('help-btn').click();
      const dlg = document.getElementById('help-modal');
      const wasOpen = dlg.open;
      document.body.focus();
      const closed = new Promise(r => dlg.addEventListener('close', r, { once: true }));
      dlg.querySelector('.modal-close').click();
      await closed;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { wasOpen, open: dlg.open, focus: document.activeElement && document.activeElement.id };
    });
    ok('help (Plan 8): the Close button closes the dialog and focus returns to #help-btn', viaClose.wasOpen && viaClose.open === false && viaClose.focus === 'help-btn', JSON.stringify(viaClose));

    // backdrop click (a real click far outside the dialog box — the event target is the dialog itself); a click on the content does NOT close
    await page.evaluate(() => { document.getElementById('help-btn').click(); });
    const inner = await page.evaluate(() => { const dlg = document.getElementById('help-modal'); dlg.querySelector('h3').click(); return dlg.open; });
    await armClose();
    await page.mouse.click(4, 4);
    const backdrop = await waitClose();
    const afterBackdrop = await page.evaluate(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return { open: document.getElementById('help-modal').open, focus: document.activeElement && document.activeElement.id }; });
    ok('help (Plan 8): a click on the content keeps the dialog open; a click on the backdrop (target === dialog) closes it and focus returns to #help-btn',
      inner === true && backdrop === true && afterBackdrop.open === false && afterBackdrop.focus === 'help-btn', JSON.stringify({ inner, backdrop, afterBackdrop }));

    // (d) `?` — a real Shift+/ press with focus on <body> opens (and closes again); the same press inside the hub search box does not open it
    await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    await page.keyboard.press('?');
    const qOpen = await page.evaluate(() => document.getElementById('help-modal').open);
    await armClose();
    await page.keyboard.press('?');
    const qToggled = await waitClose();
    const qAfter = await page.evaluate(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return { open: document.getElementById('help-modal').open, focus: document.activeElement && document.activeElement.id }; });
    ok('help (Plan 8): pressing ? with focus on <body> opens the dialog; pressing ? again closes it (toggle) and focus returns to #help-btn',
      qOpen === true && qToggled === true && qAfter.open === false && qAfter.focus === 'help-btn', JSON.stringify({ qOpen, qToggled, qAfter }));
    const boxReady = await page.evaluate(async () => {
      const box = document.getElementById('hub-search');
      App._render(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      box.hidden = false; box.value = ''; box.focus();
      return { hidden: box.hidden, focused: document.activeElement === box };
    });
    await page.keyboard.press('?');
    const inInput = await page.evaluate(() => {
      const box = document.getElementById('hub-search'), open = document.getElementById('help-modal').open, typed = box.value;
      box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); box.blur();   // reset the query the key press typed
      return { open, typed };
    });
    ok('help (Plan 8): pressing ? inside the hub search input does NOT open the dialog (the character is typed instead)',
      boxReady.focused && inInput.open === false && inInput.typed === '?', JSON.stringify({ boxReady, inInput }));
    const inTextarea = await page.evaluate(() => {
      const ta = document.createElement('textarea'); document.body.appendChild(ta); ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
      const open = document.getElementById('help-modal').open;
      ta.remove();
      const sel = document.createElement('select'); document.body.appendChild(sel); sel.focus();
      sel.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
      const open2 = document.getElementById('help-modal').open;
      sel.remove();
      return { open, open2 };
    });
    ok('help (Plan 8): ? inside a textarea or a select does not open the dialog either', inTextarea.open === false && inTextarea.open2 === false, JSON.stringify(inTextarea));

    // (e) print media hides the open dialog and the button; screen shows them again
    await page.evaluate(() => { document.getElementById('help-btn').click(); });
    await page.emulateMediaType('print');
    const printed = await page.evaluate(() => ({ dlg: getComputedStyle(document.getElementById('help-modal')).display, btn: getComputedStyle(document.getElementById('help-btn')).display, open: document.getElementById('help-modal').open }));
    await page.emulateMediaType('screen');
    const screen = await page.evaluate(async () => {
      const dlg = document.getElementById('help-modal');
      const shown = getComputedStyle(dlg).display !== 'none' && getComputedStyle(document.getElementById('help-btn')).display !== 'none';
      const closed = new Promise(r => dlg.addEventListener('close', r, { once: true }));
      dlg.close(); await closed;
      return { shown, open: dlg.open };
    });
    ok('help (Plan 8): @media print hides #help-modal (even while open) and #help-btn (display none); back on screen both show again',
      printed.dlg === 'none' && printed.btn === 'none' && printed.open === true && screen.shown && screen.open === false, JSON.stringify({ printed, screen }));
  } finally { await page.close(); }
}
