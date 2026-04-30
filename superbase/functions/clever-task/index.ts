import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
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
    return new Response("ok", {
      status: 200,
      headers: corsHeaders
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("URL");
  const supabaseServiceRoleKey = Deno.env.get("SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return jsonResponse({ error: "Missing edge function environment variables: URL and SERVICE_ROLE_KEY" }, 500);
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
      request_headers: headers,
      tracked_at: new Date().toISOString()
    })
    .eq("id", payload.signup_id);

  if (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  return jsonResponse({ ok: true });
});
