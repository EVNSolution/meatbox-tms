export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const assert = (condition, status, code) => {
  if (!condition) throw new ApiError(status, code);
};
