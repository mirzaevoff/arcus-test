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

// Коды команд (зависят от ops.ini вашего терминала; значения из доки/примеров).
// В Delphi-примере: StartArcus(1)=ОПЛАТА, StartArcus(99)=МЕНЮ АДМИНИСТРАТОРА.
const CMD_PURCHASE = Number(process.env.ARCUS_CMD_PURCHASE || 1);
const CMD_ADMIN = Number(process.env.ARCUS_CMD_ADMIN || 99);

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
  lastResult: null, // { runResult, fields, error, stoppedRequested }
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

function readField(itpos, key) {
  const buf = Buffer.alloc(256);
  const rc = ITPosGet(itpos, key, buf, buf.length);
  if (rc !== 0) return null; // ключ не заполнен / ошибка
  const s = buf.toString('latin1');
  const z = s.indexOf('\0');
  const val = (z >= 0 ? s.slice(0, z) : s).trim();
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
      state.running = false;
      state.itpos = null;
      state.lastResult = {
        op: label,
        runResult: typeof runResult === 'number' ? runResult : null,
        fields,
        error,
        finishedAt: Date.now(),
      };
      console.log(
        `[<] ${label} готово: result=${state.lastResult.runResult}` +
          (error ? `, error=${error}` : '') +
          (fields.rrn ? `, RRN=${fields.rrn}` : '') +
          (fields.response_code ? `, RC=${fields.response_code}` : '')
      );
    }
  });

  return { ok: true };
}

function stopCurrent() {
  // Есть активная операция, запущенная тулом — отменяем её объект.
  if (state.itpos) {
    console.log('[x] Stop: отмена текущей операции');
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
      lastResult: state.lastResult,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/purchase') {
    const body = await readBody(req);
    const amount = String(body.amount ?? '').replace(/\D/g, '') || '0';
    const currency = String(body.currency ?? '').replace(/\D/g, '') || '860';
    const r = startOperation({
      cmd: CMD_PURCHASE,
      label: 'Purchase',
      params: [
        { key: 'amount', value: amount },
        { key: 'currency', value: currency },
      ],
    });
    sendJson(res, r.ok ? 200 : 409, r);
    return;
  }

  if (req.method === 'POST' && req.url === '/admin') {
    // Меню администратора: без суммы/валюты, cmd=99 (зависит от ops.ini)
    const r = startOperation({ cmd: CMD_ADMIN, label: 'Admin Menu' });
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

server.listen(PORT, () => {
  console.log(`\nARCUS test tool: http://localhost:${PORT}`);
  console.log(`Библиотека: ${LIB_PATH}`);
  console.log(`Команда Purchase (cmd): ${CMD_PURCHASE}\n`);
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
  button { padding: 10px 18px; border: 0; border-radius: 6px; font-size: 15px; cursor: pointer; color: #fff; }
  #pay { background: #1a7f37; }
  #admin { background: #555; }
  #stop { background: #c8102e; font-weight: 700; padding: 10px 24px; margin-left: auto; }
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
  <h1>ARCUS test tool — Purchase / Стоп</h1>

  <div class="row">
    <div>
      <label>Сумма (минимальные единицы, без разделителей)</label>
      <input id="amount" value="2000" inputmode="numeric">
    </div>
    <div>
      <label>Валюта (ISO)</label>
      <input id="currency" value="860" style="width:90px">
    </div>
  </div>
  <p class="hint">Напр. amount=2000 &amp; currency=860 → 20.00 UZS. RUB = 643, USD = 840.</p>

  <div class="row">
    <button id="pay">Purchase</button>
    <button id="admin">Admin Menu</button>
    <button id="stop">■ СТОП — отмена любой операции</button>
  </div>

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

$('pay').onclick = async () => {
  const amount = $('amount').value;
  const currency = $('currency').value;
  const r = await post('/purchase', { amount, currency });
  if (!r.ok) alert('Ошибка: ' + (r.error || 'не удалось запустить'));
};

$('admin').onclick = async () => {
  const r = await post('/admin', {});
  if (!r.ok) alert('Ошибка: ' + (r.error || 'не удалось открыть меню'));
};

$('stop').onclick = async () => {
  const r = await post('/stop', {});
  if (!r.ok) alert('Ошибка: ' + (r.error || 'нет активной операции'));
};

async function poll() {
  try {
    const s = await (await fetch('/status')).json();
    const badge = $('status').querySelector('.badge');
    if (s.running) {
      badge.className = 'badge run';
      badge.textContent = 'операция выполняется…';
      $('pay').disabled = true;
      $('admin').disabled = true;
    } else {
      badge.className = 'badge idle';
      badge.textContent = 'ожидание';
      $('pay').disabled = false;
      $('admin').disabled = false;
    }
    // СТОП всегда активна — её можно нажать в любой момент.
    $('result').textContent = s.lastResult
      ? JSON.stringify(s.lastResult, null, 2)
      : '—';
  } catch (_) {}
}
setInterval(poll, 800);
poll();
</script>
</body>
</html>`;
