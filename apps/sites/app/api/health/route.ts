import { createLogger, getCorrelationIdFromHeaders, runWithContext } from '@platform/logger';

export const dynamic = 'force-dynamic';

const logger = createLogger({ app: 'sites' });

export function GET(request: Request) {
  const correlationId = getCorrelationIdFromHeaders(request.headers);
  const deploymentSurface = process.env.PLATFORM_DEPLOYMENT_SURFACE ?? 'local';

  return runWithContext({ correlationId, app: 'sites', deploymentSurface }, () => {
    logger.info('Health check received', {
      path: '/api/health',
      deploymentSurface,
    });

    return Response.json(
      {
        status: 'ok',
        app: 'sites',
        deploymentSurface,
      },
      {
        headers: {
          'x-correlation-id': correlationId,
        },
      },
    );
  });
}
