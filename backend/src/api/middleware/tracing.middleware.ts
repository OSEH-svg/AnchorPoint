import { Request, Response, NextFunction } from 'express';
import { trace, SpanKind, SpanStatusCode, context } from '@opentelemetry/api';
import { propagation } from '@opentelemetry/api';
import { tracingManager } from '../../utils/tracing';
import { v4 as uuidv4 } from 'uuid';

const tracer = trace.getTracer('anchorpoint-backend-express');

export const tracingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const route = req.route?.path || req.path || req.url;
  const method = req.method;
  const spanName = `${method} ${route}`;

  const correlationId = (req.headers['x-correlation-id'] as string | undefined) || uuidv4();

  const extractedContext = propagation.extract(context.active(), req.headers);
  
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.method': method,
      'http.url': req.url,
      'http.target': req.path,
      'http.host': req.get('host'),
      'http.scheme': req.protocol,
      'http.user_agent': req.get('user-agent'),
      'http.remote_addr': req.ip || req.connection.remoteAddress,
      'http.status_code': res.statusCode,
    },
  }, extractedContext);

  const newContext = trace.setSpan(extractedContext, span);
  
  const tracingContext = {
    span,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    otelContext: newContext,
    correlationId,
  };

  tracingManager.runWithContext(tracingContext, () => {
    res.setHeader('X-Trace-Id', span.spanContext().traceId);
    res.setHeader('X-Span-Id', span.spanContext().spanId);
    res.setHeader('X-Correlation-Id', correlationId);

    const originalEnd = res.end;
    res.end = function(chunk?: any, encoding?: any, cb?: any) {
      span.setAttribute('http.status_code', res.statusCode);
      
      if (res.statusCode >= 400) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${res.statusCode}`,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();
      return originalEnd.call(this, chunk, encoding, cb);
    };

    res.on('error', (error) => {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      span.end();
    });

    next();
  });
};
