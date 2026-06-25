const PASSWORD = "choose-a-password-here";

export async function onRequest({ request, next }) {
  const authHeader = request.headers.get("Authorization");

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme === "Basic") {
      const decoded = atob(encoded);
      const colonIndex = decoded.indexOf(":");
      const pass = decoded.substring(colonIndex + 1);
      if (pass === PASSWORD) {
        return next();
      }
    }
  }

  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="Hasbro Dashboard"`,
    },
  });
}
