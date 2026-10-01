import { app, dialog } from "electron";
import { formatConsoleArgs, serializeRuntimeError } from "./desktop-diagnostics.mjs";

/**
 * Crash and log capture for the packaged app — the install-once half of
 * desktop-diagnostics.mts (which owns the bounded files it writes to).
 *
 * It is the only reason a packaged install, which has no console, can show or
 * leave evidence of what went wrong. That matters most on the recovery paths:
 * a crash restart whose window reload fails has nowhere to report itself
 * except here. Electron is used directly, like tray.mts, so main.mts only
 * supplies the bounded log appender.
 */

let installed = false;

/**
 * Installs once per boot; console output is mirrored because that is how the
 * in-process service reports errors.
 */
export function installDesktopRuntimeDiagnostics(log: (event: string, detail?: Record<string, unknown>) => void): void {
  if (installed) return;
  installed = true;

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    log("console.error", { message: formatConsoleArgs(args) });
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    log("console.warn", { message: formatConsoleArgs(args) });
    originalWarn(...args);
  };

  process.on("uncaughtException", (error) => {
    log("uncaught-exception", serializeRuntimeError(error));
    originalError("Uncaught exception:", error);
    // Process state is unknown after an uncaught exception: stop deliberately
    // rather than keep syncing and sending mail from a half-built runtime.
    try {
      dialog.showErrorBox(
        "Nami Mail stopped unexpectedly",
        "Nami Mail hit an unrecoverable error and will close. Details were written to runtime-log.jsonl in the Nami Mail user data folder.",
      );
    } catch {
      // A dialog must never block shutdown.
    }
    app.quit();
  });

  process.on("unhandledRejection", (reason) => {
    log("unhandled-rejection", serializeRuntimeError(reason));
  });

  app.on("render-process-gone", (_event, _contents, details) => {
    log("render-process-gone", { reason: details.reason, exitCode: details.exitCode });
  });

  app.on("child-process-gone", (_event, details) => {
    log("child-process-gone", { type: details.type, reason: details.reason, exitCode: details.exitCode });
  });
}
