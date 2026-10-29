/** 利用者に返してよいエラー。message は画面にそのまま出る */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code = "bad_request") => new AppError(400, code, msg);
export const forbidden = (msg = "この操作は許可されていません", code = "forbidden") => new AppError(403, code, msg);
export const notFound = (msg = "見つかりません") => new AppError(404, "not_found", msg);
export const conflict = (msg: string, code = "conflict") => new AppError(409, code, msg);
