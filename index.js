/*
 * Мини тестовый тул для ARCUS 2 / ARCUS 2.1 (Ingenico / Arcom Universal EMV POS)
 *
 * Что делает:
 *   - Кнопка "Purchase"  -> ITPosSet(amount/currency) + ITPosRun(cmd) АСИНХРОННО
 *   - Кнопка "Стоп"      -> Stop(itpos) — отмена ТЕКУЩЕЙ операции, пока ITPosRun ещё висит
 *
 * Почему async: ITPosRun блокирующий (висит до завершения операции на терминале).
 * Чтобы "Стоп" мог сработать во время операции, ITPosRun запускается в отдельном
 * потоке (koffi .async), а Stop(itpos) вызывается из основного потока по тому же
 * указателю itpos. Указатель в рамках одного процесса валиден для обоих потоков.
 *
 * Запускать НА МАШИНЕ, где лежит Arccom.dll (касса / Windows), рядом с библиотекой,
 * либо указав путь через переменную окружения ARCUS_LIB.
 */

const http = require('http');
const path = require('path');
const koffi = require('koffi');

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);

// Путь к библиотеке. По умолчанию: Arccom.dll (Win) / ./libarccom.so (Linux/mac).
const LIB_PATH =
  process.env.ARCUS_LIB ||
  (process.platform === 'win32'
    ? 'Arccom.dll'
    : path.join(process.cwd(), 'libarccom.so'));

const num = (name, def) => Number(process.env[name] || def);

// Реестр операций. cmd зависит от ops.ini вашего терминала — задаётся через ENV.
// Известны из доки/примеров: Purchase=1, Admin=99 (StartArcus(1)/StartArcus(99)).
// Для остальных cmd по умолчанию 0 (не задан) — укажите ARCUS_CMD_* в run.bat,
// сверившись с ops.ini. Операция с cmd<=0 показывается, но запуск заблокирован.
// fields — какие входные параметры слать через ITPosSet.
const OPS = [
  { key: 'purchase', label: 'Purchase',         env: 'ARCUS_CMD_PURCHASE',   cmd: num('ARCUS_CMD_PURCHASE', 1),   fields: ['amount', 'currency'],        color: '#1a7f37' },
  { key: 'refund',   label: 'Возврат',          env: 'ARCUS_CMD_REFUND',     cmd: num('ARCUS_CMD_REFUND', 0),     fields: ['amount', 'currency', 'rrn'], color: '#b25e00' },
  { key: 'cancel',   label: 'Отмена последней', env: 'ARCUS_CMD_CANCEL',     cmd: num('ARCUS_CMD_CANCEL', 0),     fields: [],                            color: '#7a4eab' },
  { key: 'settle',   label: 'Сверка итогов',    env: 'ARCUS_CMD_SETTLEMENT', cmd: num('ARCUS_CMD_SETTLEMENT', 0), fields: [],                            color: '#0b6e75' },
  { key: 'admin',    label: 'Admin Menu',       env: 'ARCUS_CMD_ADMIN',      cmd: num('ARCUS_CMD_ADMIN', 99),     fields: [],                            color: '#555' },
];
const OP_BY_KEY = Object.fromEntries(OPS.map((o) => [o.key, o]));

// ---------------------------------------------------------------------------
// Загрузка библиотеки и объявление функций (прототипы из доки, __cdecl)
// ---------------------------------------------------------------------------
let lib;
try {
  lib = koffi.load(LIB_PATH);
} catch (e) {
  console.error(`\n[!] Не удалось загрузить библиотеку ARCUS: ${LIB_PATH}`);
  console.error(`    ${e.message}`);
  console.error(`\n    Подсказки:`);
  console.error(`    - Запускайте тул на машине с Arccom.dll (касса/Windows).`);
  console.error(`    - Укажите путь: ARCUS_LIB=C:\\path\\to\\Arccom.dll npm start`);
  console.error(`    - Разрядность Node должна совпадать с разрядностью DLL`);
  console.error(`      (32-битная DLL -> нужен 32-битный Node!).\n`);
  process.exit(1);
}

// void*  CreateITPos();
const CreateITPos = lib.func('CreateITPos', 'void*', []);
// void   DeleteITPos(void*);
const DeleteITPos = lib.func('DeleteITPos', 'void', ['void*']);
// int    ITPosSet(void*, const char* key, const char* value, int size);
const ITPosSet = lib.func('ITPosSet', 'int', ['void*', 'str', 'str', 'int']);
// int    ITPosGet(void*, const char* key, char* value, int size);  (value — out-буфер)
const ITPosGet = lib.func('ITPosGet', 'int', ['void*', 'str', 'void*', 'int']);
// int    ITPosRun(void*, int cmd);
const ITPosRun = lib.func('ITPosRun', 'int', ['void*', 'int']);

// Отмена операции. Экспортируемый символ DLL — "Stop"
// (GET_DLL_FUNC(StopITPos, _StopITPos, "Stop")).
const Stop = lib.func('Stop', 'void', ['void*']);

// ---------------------------------------------------------------------------
// Состояние операции (одна за раз)
// ---------------------------------------------------------------------------
const state = {
  running: false,
  itpos: null,
  startedAt: null,
  stopRequestedAt: null, // когда нажали Stop (для замера реакции)
  lastResult: null,
};

// Список выходных ключей для чтения результата (Приложение 1 доки)
const OUT_KEYS = [
  'response_code',
  'text_message',
  'received_text_message',
  'rrn',
  'auth_code',
  'pan',
  'result_amount',
  'amount',
  'card_type',
  'application_label',
  'terminal_id',
  'cardholder_name',
  'date',
  'time',
];

// Текстовые поля ARCUS приходят в CP1251. Декодируем в Unicode без зависимостей.
// Нерегулярная часть 0x80..0xBF — таблицей; 0xC0..0xFF — это А..я (0x0410..0x044F).
const CP1251_80_BF = [
  0x0402,0x0403,0x201A,0x0453,0x201E,0x2026,0x2020,0x2021,0x20AC,0x2030,0x0409,0x2039,0x040A,0x040C,0x040B,0x040F,
  0x0452,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0xFFFD,0x2122,0x0459,0x203A,0x045A,0x045C,0x045B,0x045F,
  0x00A0,0x040E,0x045E,0x0408,0x00A4,0x0490,0x00A6,0x00A7,0x0401,0x00A9,0x0404,0x00AB,0x00AC,0x00AD,0x00AE,0x0407,
  0x00B0,0x00B1,0x0406,0x0456,0x0491,0x00B5,0x00B6,0x00B7,0x0451,0x2116,0x0454,0x00BB,0x0458,0x0405,0x0455,0x0457,
].map((c) => String.fromCharCode(c)).join('');

function decodeCp1251(buf, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xc0) s += CP1251_80_BF[b - 0x80];
    else s += String.fromCharCode(0x0410 + (b - 0xc0)); // 0xC0..0xFF -> А..я
  }
  return s;
}

function readField(itpos, key) {
  const buf = Buffer.alloc(256);
  const rc = ITPosGet(itpos, key, buf, buf.length);
  if (rc !== 0) return null; // ключ не заполнен / ошибка
  let len = buf.indexOf(0); // длина до нуль-терминатора
  if (len < 0) len = buf.length;
  const val = decodeCp1251(buf, len).trim();
  return val.length ? val : null;
}

function collectResult(itpos) {
  const fields = {};
  for (const k of OUT_KEYS) {
    const v = readField(itpos, k);
    if (v !== null) fields[k] = v;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Логика операций
// ---------------------------------------------------------------------------
// Универсальный запуск операции. params — список { key, value } для ITPosSet
// (для Purchase это amount/currency; для Admin Menu — пусто).
function startOperation({ cmd, label, params = [] }) {
  if (state.running) {
    return { ok: false, error: 'Операция уже выполняется' };
  }

  const itpos = CreateITPos();
  if (!itpos) {
    return { ok: false, error: 'CreateITPos вернул NULL (объект не создан)' };
  }

  // Входные параметры. size = -1 -> длина считается как для ASCII-строки.
  for (const { key, value } of params) {
    const rc = ITPosSet(itpos, key, String(value), -1);
    if (rc !== 0) {
      DeleteITPos(itpos);
      return { ok: false, error: `ITPosSet(${key}) -> ${rc}` };
    }
  }

  state.running = true;
  state.itpos = itpos;
  state.startedAt = Date.now();
  state.stopRequestedAt = null;
  state.lastResult = null;
  state.op = label;

  const paramsStr = params.map((p) => `${p.key}=${p.value}`).join(', ');
  console.log(`[>] ${label}: cmd=${cmd}${paramsStr ? ', ' + paramsStr : ''}`);

  // АСИНХРОННЫЙ запуск: основной поток свободен, "Стоп" сможет сработать.
  ITPosRun.async(itpos, cmd, (err, runResult) => {
    let fields = {};
    let error = null;
    try {
      if (err) {
        error = String(err.message || err);
      } else {
        fields = collectResult(itpos);
      }
    } catch (e) {
      error = String(e.message || e);
    } finally {
      try {
        DeleteITPos(itpos);
      } catch (_) {}
      // Если Stop был запрошен — сколько мс прошло до завершения Run.
      // Малое значение = Stop реально прервал операцию.
      const stoppedAfterMs = state.stopRequestedAt
        ? Date.now() - state.stopRequestedAt
        : null;

      state.running = false;
      state.itpos = null;
      state.lastResult = {
        op: label,
        runResult: typeof runResult === 'number' ? runResult : null,
        stoppedAfterMs, // null = Stop не нажимали
        fields,
        error,
        finishedAt: Date.now(),
      };
      console.log(
        `[<] ${label} готово: result=${state.lastResult.runResult}` +
          (stoppedAfterMs != null ? `, завершилось через ${stoppedAfterMs}мс после Stop` : '') +
          (error ? `, error=${error}` : '') +
          (fields.rrn ? `, RRN=${fields.rrn}` : '') +
          (fields.response_code ? `, RC=${fields.response_code}` : '')
      );
      state.stopRequestedAt = null;
    }
  });

  return { ok: true };
}

// Запуск операции по ключу из реестра OPS. body — входные значения полей.
function runOp(opKey, body = {}) {
  const op = OP_BY_KEY[opKey];
  if (!op) return { ok: false, error: `Неизвестная операция: ${opKey}` };
  if (!(op.cmd > 0)) {
    return {
      ok: false,
      error: `Команда для "${op.label}" не задана. Укажите ${op.env} в run.bat (см. ops.ini).`,
    };
  }

  const params = [];
  for (const f of op.fields) {
    let v = String(body[f] ?? '');
    if (f === 'amount' || f === 'currency') v = v.replace(/\D/g, '');
    if (f === 'amount' && !v) return { ok: false, error: 'Укажите сумму' };
    if (f === 'currency' && !v) v = '860';
    if (v) params.push({ key: f, value: v });
  }

  return startOperation({ cmd: op.cmd, label: op.label, params });
}

function stopCurrent() {
  // Есть активная операция, запущенная тулом — отменяем её объект.
  if (state.itpos) {
    console.log(`[x] Stop: отмена текущей операции (${state.op})`);
    state.stopRequestedAt = Date.now();
    try {
      Stop(state.itpos);
      return { ok: true, mode: 'current' };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  // Активной операции тула нет (например, запущено вручную) — best-effort:
  // создаём временный объект и всё равно шлём Stop на терминал.
  console.log('[x] Stop: принудительная отмена (нет активной операции тула)');
  let tmp = null;
  try {
    tmp = CreateITPos();
    if (!tmp) return { ok: false, error: 'CreateITPos вернул NULL' };
    Stop(tmp);
    return { ok: true, mode: 'forced' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    if (tmp) {
      try {
        DeleteITPos(tmp);
      } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP сервер + веб-интерфейс
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    sendJson(res, 200, {
      running: state.running,
      startedAt: state.startedAt,
      stopAgoMs: state.stopRequestedAt ? Date.now() - state.stopRequestedAt : null,
      lastResult: state.lastResult,
    });
    return;
  }

  // Список операций для UI (без приватных полей)
  if (req.method === 'GET' && req.url === '/ops') {
    sendJson(
      res,
      200,
      OPS.map((o) => ({
        key: o.key,
        label: o.label,
        fields: o.fields,
        color: o.color,
        ready: o.cmd > 0, // false -> кнопка показана, но запуск заблокирован
        cmd: o.cmd,
      }))
    );
    return;
  }

  // Запуск любой операции: POST /op/<key>
  if (req.method === 'POST' && req.url.startsWith('/op/')) {
    const key = decodeURIComponent(req.url.slice('/op/'.length));
    const body = await readBody(req);
    const r = runOp(key, body);
    sendJson(res, r.ok ? 200 : 409, r);
    return;
  }

  if (req.method === 'POST' && req.url === '/stop') {
    const r = stopCurrent();
    sendJson(res, r.ok ? 200 : 409, r);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[!] Порт ${PORT} занят. Закройте другой экземпляр тула или задайте PORT.\n`);
  } else {
    console.error('[!] Ошибка сервера:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\nARCUS test tool: http://localhost:${PORT}`);
  console.log(`Библиотека: ${LIB_PATH}`);
  console.log('Операции (cmd):');
  for (const o of OPS) {
    console.log(`  ${o.label.padEnd(18)} cmd=${o.cmd}${o.cmd > 0 ? '' : `  (не задан — ${o.env})`}`);
  }
  console.log('');
});

// ---------------------------------------------------------------------------
// Встроенный HTML
// ---------------------------------------------------------------------------
const HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARCUS test tool</title>
<style>
  :root { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  body { max-width: 640px; margin: 32px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 20px; }
  .row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin: 16px 0; }
  label { display: block; font-size: 12px; color: #666; margin-bottom: 4px; }
  input { padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 15px; width: 140px; }
  button { padding: 10px 18px; border: 0; border-radius: 6px; font-size: 15px; cursor: pointer; color: #fff; background: #333; }
  #stop { background: #c8102e; font-weight: 700; padding: 10px 24px; }
  button:disabled { opacity: .35; cursor: not-allowed; }
  #status { margin-top: 16px; font-size: 14px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; }
  .idle { background: #eee; color: #555; }
  .run  { background: #fff3cd; color: #8a6d00; }
  pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 12px; overflow:auto; font-size: 13px; }
  .hint { color:#888; font-size:12px; }
</style>
</head>
<body>
  <h1>ARCUS test tool</h1>

  <div class="row">
    <div>
      <label>Сумма (минимальные единицы)</label>
      <input id="amount" value="2000" inputmode="numeric">
    </div>
    <div>
      <label>Валюта (ISO)</label>
      <input id="currency" value="860" style="width:90px">
    </div>
    <div>
      <label>RRN (для возврата/отмены)</label>
      <input id="rrn" placeholder="необязательно">
    </div>
  </div>
  <p class="hint">amount=2000 &amp; currency=860 → 20.00 UZS. RUB = 643, USD = 840. Кнопка с ⚠ — не задан cmd в run.bat.</p>

  <div class="row" id="ops"></div>
  <div class="row"><button id="stop">■ СТОП — отмена любой операции</button></div>

  <div id="status">Статус: <span class="badge idle">ожидание</span></div>
  <pre id="result">—</pre>

<script>
const $ = (id) => document.getElementById(id);

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

let OPS = [];

// собрать тело запроса из полей, которые нужны операции
function payload(op) {
  const b = {};
  if (op.fields.includes('amount')) b.amount = $('amount').value;
  if (op.fields.includes('currency')) b.currency = $('currency').value;
  if (op.fields.includes('rrn')) b.rrn = $('rrn').value;
  return b;
}

// построить кнопки из реестра операций
async function loadOps() {
  OPS = await (await fetch('/ops')).json();
  const box = $('ops');
  box.innerHTML = '';
  for (const op of OPS) {
    const btn = document.createElement('button');
    btn.textContent = op.label + (op.ready ? '' : ' ⚠');
    btn.dataset.key = op.key;
    if (op.color) btn.style.background = op.color;
    if (!op.ready) btn.title = 'Команда не задана (cmd=0). Укажите ' + op.key + ' в run.bat (ops.ini).';
    btn.onclick = async () => {
      const r = await post('/op/' + encodeURIComponent(op.key), payload(op));
      if (!r.ok) alert('Ошибка: ' + (r.error || 'не удалось запустить'));
    };
    box.appendChild(btn);
  }
}

$('stop').onclick = async () => {
  const r = await post('/stop', {});
  if (!r.ok) alert('Ошибка: ' + (r.error || 'нет активной операции'));
};

async function poll() {
  try {
    const s = await (await fetch('/status')).json();
    const badge = $('status').querySelector('.badge');
    const running = s.running;
    badge.className = running ? 'badge run' : 'badge idle';
    if (running && s.stopAgoMs != null) {
      badge.textContent = 'Stop отправлен ' + Math.round(s.stopAgoMs / 1000) + 'с назад — НЕ прервалось…';
    } else {
      badge.textContent = running ? 'операция выполняется…' : 'ожидание';
    }
    // во время операции операционные кнопки блокируем; СТОП всегда активна
    document.querySelectorAll('#ops button').forEach((b) => {
      const op = OPS.find((o) => o.key === b.dataset.key);
      b.disabled = running || !(op && op.ready);
    });
    $('result').textContent = s.lastResult ? JSON.stringify(s.lastResult, null, 2) : '—';
  } catch (_) {
    const badge = $('status').querySelector('.badge');
    if (badge) { badge.className = 'badge idle'; badge.textContent = 'нет связи'; }
  }
}

loadOps().then(() => { setInterval(poll, 800); poll(); });
</script>
</body>
</html>`;
