export function errorResponse(statusCode: number, code: string, message: string, requestId: string) {
  return {
    error: {
      code,
      message,
      requestId,
    },
    statusCode,
  };
}
