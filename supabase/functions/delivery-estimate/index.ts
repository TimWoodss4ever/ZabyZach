import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const origins: Record<string, string> = {
  'Provo Campus Store': '150 N University Ave, Provo, UT 84601',
  'Orem Store': '470 N State St, Orem, UT 84057',
};

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405, headers: cors });

  const apiKey = Deno.env.get('GOOGLE_ROUTES_API_KEY');
  if (!apiKey) return Response.json({ error: 'Delivery routing is not configured yet.' }, { status: 503, headers: cors });

  try {
    const body = await request.json() as { location?: unknown; address?: unknown };
    const origin = typeof body.location === 'string' ? origins[body.location] : undefined;
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (!origin || address.length < 8 || address.length > 240) {
      return Response.json({ error: 'Choose a store and enter a complete delivery address.' }, { status: 400, headers: cors });
    }

    const routeResponse = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        departureTime: new Date(Date.now() + 5 * 60_000).toISOString(),
        languageCode: 'en-US',
        units: 'IMPERIAL',
      }),
    });
    if (!routeResponse.ok) {
      return Response.json({ error: 'We could not calculate a route for that address. Check it and try again.' }, { status: 502, headers: cors });
    }
    const data = await routeResponse.json() as { routes?: { duration?: string; distanceMeters?: number }[] };
    const route = data.routes?.[0];
    const seconds = Number(route?.duration?.replace(/s$/, ''));
    const distanceMeters = Number(route?.distanceMeters);
    if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(distanceMeters) || distanceMeters <= 0) {
      return Response.json({ error: 'No driving route was found for that address.' }, { status: 422, headers: cors });
    }
    const oneWayMinutes = Math.ceil(seconds / 60);
    if (oneWayMinutes > 20) {
      return Response.json({ error: 'That address is outside the 20-minute delivery area.' }, { status: 422, headers: cors });
    }
    return Response.json({
      oneWayMinutes,
      distanceMiles: distanceMeters / 1609.344,
    }, { headers: cors });
  } catch {
    return Response.json({ error: 'The delivery estimate could not be completed. Please try again.' }, { status: 400, headers: cors });
  }
});
