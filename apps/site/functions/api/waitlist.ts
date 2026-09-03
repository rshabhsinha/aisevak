interface Env {
  LISTMONK_URL?: string;
  LISTMONK_API_USERNAME?: string;
  LISTMONK_API_TOKEN?: string;
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const body = (await request.json()) as {
      email?: string;
      name?: string;
      attribs?: Record<string, unknown>;
    };

    if (!body.email || !body.email.includes("@")) {
      return new Response(
        JSON.stringify({ error: "A valid email is required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const listmonkUrl = env.LISTMONK_URL || "https://newsletter.embedr.app";
    const username = env.LISTMONK_API_USERNAME || "admin";
    const token = env.LISTMONK_API_TOKEN || "";

    const listmonkPayload = {
      email: body.email,
      name: body.name || body.email.split("@")[0],
      status: "enabled",
      lists: [7], // List ID 7 - "AiSevak Waitlist"
      preconfirm_subscriptions: true,
      attribs: {
        agent_count: body.attribs?.agent_count || "3-5",
        signup_source: "aisevak.com",
        embedr_consent: {
          source: "aisevak.com waitlist form",
          at: new Date().toISOString()
        }
      }
    };

    // If API credentials are not yet set up on local dev, return success mock
    if (!token) {
      return new Response(
        JSON.stringify({
          success: true,
          mock: true,
          message: "Waitlist entry received (mock mode)"
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    const authHeader = "Basic " + btoa(`${username}:${token}`);

    const res = await fetch(`${listmonkUrl}/api/subscribers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader
      },
      body: JSON.stringify(listmonkPayload)
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(
        JSON.stringify({ error: "Failed to subscribe to waitlist", details: errText }),
        { status: res.status, headers: corsHeaders }
      );
    }

    const data = await res.json();
    return new Response(
      JSON.stringify({ success: true, data }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal Server Error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
