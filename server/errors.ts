export class HttpError extends Error {
  readonly status: number
  readonly code: number

  constructor(status: number, message: string, code = status * 100 + 1) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const bad = (message: string) => new HttpError(400, message)
export const unauthorized = (message = '未登录或登录已过期') => new HttpError(401, message)
export const forbidden = (message: string) => new HttpError(403, message)
export const notFound = (message = '资源不存在') => new HttpError(404, message)
export const conflict = (message: string) => new HttpError(409, message)
