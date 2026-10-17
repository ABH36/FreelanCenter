export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    status: 'ok',
    app: 'sites',
    deploymentSurface: process.env.PLATFORM_DEPLOYMENT_SURFACE ?? 'local',
  });
}
