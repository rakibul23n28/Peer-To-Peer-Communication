export function errorResponse(
  statusCodeOrCode: number | string,
  codeOrMessage: string,
  messageOrRequestId?: string,
  requestId?: string,
) {
  if (typeof statusCodeOrCode === 'string') {
    const code = statusCodeOrCode;
    const message = codeOrMessage;
    const requestIdValue = messageOrRequestId ?? 'req-local';
    return {
      error: {
        code,
        message,
        requestId: requestIdValue,
      },
    };
  }

  const statusCode = statusCodeOrCode;
  const code = codeOrMessage;
  const message = messageOrRequestId ?? 'Internal server error';
  const requestIdValue = requestId ?? 'req-local';

  return {
    statusCode,
    error: {
      code,
      message,
      requestId: requestIdValue,
    },
  };
}
