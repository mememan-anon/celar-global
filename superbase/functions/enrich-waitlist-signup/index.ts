import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function pickIpAddress(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || null;
  }

  return request.headers.get("x-real-ip");
}

function pickRequestHeaders(request: Request) {
  return {
    user_agent: request.headers.get("user-agent"),
    x_forwarded_for: request.headers.get("x-forwarded-for"),
    x_real_ip: request.headers.get("x-real-ip"),
    cf_connecting_ip: request.headers.get("cf-connecting-ip"),
    x_forwarded_proto: request.headers.get("x-forwarded-proto"),
    referer: request.headers.get("referer")
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return jsonResponse({ error: "Missing edge function environment variables" }, 500);
  }

  let payload: { signup_id?: string } = {};

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!payload.signup_id) {
    return jsonResponse({ error: "signup_id is required" }, 400);
  }

  const ipAddress = pickIpAddress(request);
  const headers = pickRequestHeaders(request);
  const country = request.headers.get("x-vercel-ip-country") || request.headers.get("cf-ipcountry");
  const region = request.headers.get("x-vercel-ip-country-region") || request.headers.get("x-country-region");
  const city = request.headers.get("x-vercel-ip-city") || request.headers.get("x-city");
  const timezone = request.headers.get("x-vercel-ip-timezone") || request.headers.get("x-timezone");

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { error } = await adminClient
    .from("waitlist_signups")
    .update({
      ip_address: ipAddress,
      ip_country: country,
      ip_region: region,
      ip_city: city,
      ip_timezone: timezone,
      request_headers: headers,
      tracked_at: new Date().toISOString()
    })
    .eq("id", payload.signup_id);

  if (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  return jsonResponse({ ok: true });
});
