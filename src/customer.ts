import { importPKCS8, SignJWT } from "jose";

type SupportedAlg = "RS256" | "ES256";

type GenerateLicenseTokenParams = {
  clientId: string;
  customerSystemId: string;
  kid: string;
  privateKeyPem: string;
  tokenEndpoint: string;
  resourceUrl: string;
  licenseXml: string;
  debug?: boolean;
};

type GenerateCustomerJwtParams = {
  customerURN: string;
  customerSystemId: string;
  kid: string;
  privateKeyPem: string;
  expirationSeconds?: number;
};

async function importKeyForAlgs(
  privateKeyPem: string,
  debug: boolean | undefined
): Promise<{ key: CryptoKey; alg: SupportedAlg }> {
  const supportedAlgs: SupportedAlg[] = ["RS256", "ES256"];

  for (const algorithm of supportedAlgs) {
    try {
      const key = await importPKCS8(privateKeyPem, algorithm);
      return { key, alg: algorithm };
    } catch (importError) {
      if (debug) {
        console.debug(
          `Private key did not import using ${algorithm}, retrying...`,
          importError
        );
      }
    }
  }

  throw new Error(
    "Unsupported private key format. Expected RSA or P-256 EC private key."
  );
}

export async function generateLicenseToken({
  clientId,
  customerSystemId,
  kid,
  privateKeyPem,
  tokenEndpoint,
  resourceUrl,
  licenseXml,
  debug,
}: GenerateLicenseTokenParams): Promise<string> {
  const { key, alg } = await importKeyForAlgs(privateKeyPem, debug);
  const now = Math.floor(Date.now() / 1000);

  const clientAssertion = await new SignJWT({})
    .setProtectedHeader({ alg, kid, customer_system_id: customerSystemId })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setAudience(tokenEndpoint)
    .sign(key);

  const payload = new URLSearchParams({
    grant_type: "rsl",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion,
    license: licenseXml,
    resource: resourceUrl,
  });

  const requestOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: payload.toString(),
  };

  try {
    const response = await fetch(tokenEndpoint, requestOptions);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const errorMessage = `Failed to obtain license token: ${
        response.status
      } ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`;
      throw new Error(errorMessage);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (parseError) {
      if (debug) {
        console.error(
          "Failed to parse license token response as JSON:",
          parseError
        );
      }
      throw new Error("Failed to parse license token response as JSON");
    }

    if (!data?.access_token) {
      throw new Error("License token response missing access_token");
    }

    return data.access_token;
  } catch (error) {
    if (debug) {
      console.error("Error generating license token:", error);
    }
    throw error;
  }
}

export async function generateCustomerJWT({
  customerURN,
  customerSystemId,
  kid,
  privateKeyPem,
  expirationSeconds = 3600,
}: GenerateCustomerJwtParams): Promise<string> {
  const alg: SupportedAlg = "RS256";
  const key = await importPKCS8(privateKeyPem, alg);

  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg, kid, customer_system_id: customerSystemId })
    .setIssuer(customerURN)
    .setIssuedAt(now)
    .setExpirationTime(now + expirationSeconds)
    .sign(key);
}

export type { GenerateLicenseTokenParams, GenerateCustomerJwtParams };
