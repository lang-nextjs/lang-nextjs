import jsonwebtoken from "jsonwebtoken";

/**
 * Generates a JWT for GitHub App authentication
 */
export function generateJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  
  // Add a 30-second buffer for clock skew issues
  const issuedAt = now - 30; // Issue the token 30 seconds in the past
  const expiresAt = now + (9 * 60); // 9 minutes from now (shorter than max 10 minutes)

  const payload = {
    iat: issuedAt,
    exp: expiresAt,
    iss: appId,
  };

  return jsonwebtoken.sign(payload, privateKey, { algorithm: "RS256" });
}
