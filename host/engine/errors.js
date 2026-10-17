/**
 * 建库引擎的错误类型：所有失败一律抛 EngineError，带稳定 code 与中文 message。
 * code 是给上层（路由 / 测试 / 仪表盘）判定的，message 是给人看的。
 */
export class EngineError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export const CODES = {
  INVALID_ROOT: 'INVALID_ROOT',
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  NOT_DIRECTORY: 'NOT_DIRECTORY',
  FORBIDDEN_ROOT: 'FORBIDDEN_ROOT',
  PATH_ESCAPE: 'PATH_ESCAPE',
  PATH_DENIED: 'PATH_DENIED',
  ABORTED: 'ABORTED',
  MODE_INVALID: 'MODE_INVALID',
  MODE_CONFLICT: 'MODE_CONFLICT',
  VAULT_INVALID: 'VAULT_INVALID',
  ASSETS_MISSING: 'ASSETS_MISSING',
  WRITE_FAILED: 'WRITE_FAILED',
  PATH_TOO_LONG: 'PATH_TOO_LONG',
  FILE_BUSY: 'FILE_BUSY',
};

export function fail(code, message, detail) {
  throw new EngineError(code, message, detail);
}

/**
 * 引擎在每个步骤边界调用：shouldAbort 返回字符串即中断，抛 EngineError('ABORTED')。
 * 返回 false / undefined / null 表示继续。
 */
export function throwIfAborted(shouldAbort) {
  if (typeof shouldAbort !== 'function') return;
  let reason;
  try {
    reason = shouldAbort();
  } catch (err) {
    reason = `shouldAbort 回调抛错：${err && err.message ? err.message : err}`;
  }
  if (reason) {
    throw new EngineError(CODES.ABORTED, String(reason));
  }
}
