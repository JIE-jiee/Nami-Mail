const fs = require("node:fs");

const path = "apps/web/src/App.tsx";
const text = fs.readFileSync(path, "utf8");
const crlf = (text.match(/\r\n/g) || []).length;
const lf = (text.match(/\n/g) || []).length;
if (crlf !== lf || crlf === 0) throw new Error(`行尾异常 CRLF=${crlf} LF=${lf}`);
const eol = "\r\n";
const lines = text.split(eol);

function expect(no, expected) {
  if (lines[no - 1] !== expected) {
    throw new Error(`第 ${no} 行漂移\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(lines[no - 1])}`);
  }
}

expect(59, 'import { ApiError, api, type BatchJobCreatePayload, type BatchJobQuery, type BatchJobSnapshot, type MoveTarget } from "./api";');
expect(541, "  const batchJobStartedAtRef = useRef(0);");
expect(2617, "  // Polls a server-side batch job until it settles, then shows the real");
expect(2700, "  }, [pollBatchJob, showToast, t]);");

const replacement = [
  "  // Batch job state machine lives in batchJobRunner.ts (unit-tested there);",
  "  // App wires the React-side callbacks: snapshot/busy state, toasts, reload.",
  "  const batchJobRunner = useMemo(() => createBatchJobRunner({",
  "    showToast,",
  "    t,",
  "    reload: (opts) => loadRef.current(opts),",
  "    exitSelectionMode,",
  "    onSnapshot: setBatchJob,",
  "    onBusy: setBatchBusy,",
  "  }), [exitSelectionMode, showToast, t]);",
  "",
  "  const startBatchJob = useCallback((payload: BatchJobCreatePayload, opts: BatchJobRunOptions) => {",
  "    batchJobRunner.start(payload, opts);",
  "  }, [batchJobRunner]);",
];

const ops = [
  [2617, 84, replacement],
  [541, 1, []],
  [59, 1, [
    'import { ApiError, api, type BatchJobCreatePayload, type BatchJobQuery, type BatchJobSnapshot, type MoveTarget } from "./api";',
    'import { createBatchJobRunner, type BatchJobRunOptions } from "./batchJobRunner";',
  ]],
];
for (const [start, remove, insert] of ops) {
  console.log(`@${start}: -${remove} +${insert.length}`);
  lines.splice(start - 1, remove, ...insert);
}

let out = lines.join(eol);
// App.tsx 本就存在一处三连换行（预先存在），故不做全局空行收敛，避免无关 diff。

fs.writeFileSync(path, out, "utf8");
console.log("done. lines:", out.split(eol).length, "(was", text.split(eol).length + ")");
