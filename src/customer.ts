import { importPKCS8, SignJWT } from "jose";

type SupportedAlg = "RS256" | "ES256";

type GenerateLicenseTokenParams = {
  clientId: string;
  kid: string;
  privateKeyPem: string;
  tokenEndpoint: string;
  resourceUrl: string;
  licenseXml: string;
  debug?: boolean;
};

type ObtainLicenseTokenParams = {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  resourceUrl: string;
  licenseXml: string;
  debug?: boolean;
};

async function retrieveLicenseToken(
    tokenEndpoint: string,
    requestOptions: RequestInit,
    debug: boolean | undefined
) {
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

async function importKeyForAlgs(
  privateKeyPem: string,
  debug: boolean | undefined
): Promise<{ key: CryptoKey; alg: SupportedAlg }> {
  const supportedAlgs: SupportedAlg[] = ["ES256", "RS256"];

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

// Temporarily not exporting this function to reflect only client credentials flow being supported
async function generateLicenseToken({
  clientId,
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
    .setProtectedHeader({ alg, kid })
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

  return retrieveLicenseToken(tokenEndpoint, requestOptions, debug);
}

export async function obtainLicenseToken({
  clientId,
  clientSecret,
  tokenEndpoint,
  resourceUrl,
  licenseXml,
  debug,
}: ObtainLicenseTokenParams): Promise<string> {
  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    license: licenseXml,
    resource: resourceUrl,
  });

  const requestOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
    },
    body: payload.toString(),
  };

  return retrieveLicenseToken(tokenEndpoint, requestOptions, debug);
}

export type { GenerateLicenseTokenParams, ObtainLicenseTokenParams };
