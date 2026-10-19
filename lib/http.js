export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

export const siteUrl = (request) => (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
