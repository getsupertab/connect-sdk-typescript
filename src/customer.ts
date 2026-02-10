import { loadKeyImport, loadJwtSign } from "./jose";

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
  resourceUrl: string;
  debug?: boolean;
};

type ContentBlock = {
  urlPattern: string;
  licenseXml: string;
  server: string;
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
  const { importPKCS8 } = await loadKeyImport();
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
  const { SignJWT } = await loadJwtSign();
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

async function fetchLicenseXml(
  resourceUrl: string,
  debug: boolean | undefined
): Promise<string> {
  const origin = new URL(resourceUrl).origin;
  const licenseXmlUrl = `${origin}/license.xml`;

  const response = await fetch(licenseXmlUrl);
  if (!response.ok) {
    if (debug) {
      console.error(`Failed to fetch license.xml from ${licenseXmlUrl}: ${response.status}`);
    }
    throw new Error(
      `Failed to fetch license.xml from ${licenseXmlUrl}: ${response.status}`
    );
  }

  const xml = await response.text();
  if (debug) {
    console.debug("Fetched license.xml from", licenseXmlUrl);
  }
  return xml;
}

function parseContentElements(xml: string, debug?: boolean): ContentBlock[] {
  const contentBlocks: ContentBlock[] = [];
  const contentRegex = /<content\s([^>]*)>([\s\S]*?)<\/content>/gi;
  const urlRegex = /url\s*=\s*"([^"]*)"/i;
  const serverRegex = /server\s*=\s*"([^"]*)"/i;
  const licenseRegex = /<license[^>]*>[\s\S]*?<\/license>/i;

  let elementCount = 0;
  let match;
  while ((match = contentRegex.exec(xml)) !== null) {
    elementCount++;
    const attrs = match[1];
    const body = match[2];
    const urlMatch = attrs.match(urlRegex);
    const serverMatch = attrs.match(serverRegex);
    const licenseMatch = body.match(licenseRegex);

    if (urlMatch && serverMatch && licenseMatch) {
      contentBlocks.push({
        urlPattern: urlMatch[1],
        server: serverMatch[1],
        licenseXml: licenseMatch[0],
      });
    } else if (debug) {
      const missing = [
        !urlMatch && "url",
        !serverMatch && "server",
        !licenseMatch && "<license>",
      ].filter(Boolean).join(", ");
      console.debug(`Skipping <content> element #${elementCount}: missing ${missing}`);
    }
  }

  if (debug) {
    console.debug(`Found ${elementCount} <content> element(s), ${contentBlocks.length} valid`);
  }

  return contentBlocks;
}

function findBestMatchingContent(
  contentBlocks: ContentBlock[],
  resourceUrl: string,
  debug?: boolean
): ContentBlock | null {
  const parsed = new URL(resourceUrl);
  const host = parsed.host;
  const path = parsed.pathname;

  if (debug) {
    console.debug(`Matching resource URL: ${resourceUrl} (host=${host}, path=${path})`);
  }

  let bestMatch: ContentBlock | null = null;
  let bestSpecificity = -1;

  for (const block of contentBlocks) {
    let patternUrl: URL;
    try {
      patternUrl = new URL(block.urlPattern);
    } catch {
      if (debug) {
        console.debug(`Skipping block with invalid URL pattern: ${block.urlPattern}`);
      }
      continue;
    }

    if (patternUrl.host !== host) {
      if (debug) {
        console.debug(`Skipping block: host mismatch (pattern=${patternUrl.host}, resource=${host})`);
      }
      continue;
    }

    const patternPath = patternUrl.pathname;

    if (patternPath === path) {
      if (debug) {
        console.debug(`Exact match found: ${block.urlPattern}`);
      }
      return block;
    }

    if (patternPath.endsWith("/*")) {
      const prefix = patternPath.slice(0, -1); // remove trailing *
      if (path.startsWith(prefix)) {
        const specificity = prefix.length;
        if (specificity > bestSpecificity) {
          bestSpecificity = specificity;
          bestMatch = block;
        }
      }
    }
  }

  if (debug) {
    if (bestMatch) {
      console.debug(`Wildcard match found: ${bestMatch.urlPattern} (specificity=${bestSpecificity})`);
    } else {
      console.debug(`No matching content block found for ${resourceUrl}`);
    }
  }

  return bestMatch;
}

export { parseContentElements, findBestMatchingContent };
export type { ContentBlock };

export async function obtainLicenseToken({
  clientId,
  clientSecret,
  resourceUrl,
  debug,
}: ObtainLicenseTokenParams): Promise<string> {
  const xml = await fetchLicenseXml(resourceUrl, debug);
  if (debug) {
    console.debug(`Fetched license.xml (${xml.length} chars)`);
  }
  const contentBlocks = parseContentElements(xml, debug);

  if (contentBlocks.length === 0) {
    if (debug) {
      console.error("No valid <content> elements with <license> found in license.xml");
    }
    throw new Error(
      "No valid <content> elements with <license> found in license.xml"
    );
  }

  const matchedContent = findBestMatchingContent(contentBlocks, resourceUrl, debug);
  if (!matchedContent) {
    if (debug) {
      const patterns = contentBlocks.map(b => b.urlPattern).join(", ");
      console.error(`No <content> element matches resource URL: ${resourceUrl}. Available patterns: ${patterns}`);
    }
    throw new Error(
      `No <content> element in license.xml matches resource URL: ${resourceUrl}`
    );
  }

  if (debug) {
    console.debug("Matched content block for resource URL:", resourceUrl);
    console.debug("Using license XML:", matchedContent.licenseXml);
  }

  const tokenEndpoint = matchedContent.server + '/token';
  if (debug) {
    console.debug(`Requesting license token from ${tokenEndpoint}`);
  }

  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    license: matchedContent.licenseXml,
    resource: matchedContent.urlPattern,
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

export type { ObtainLicenseTokenParams };
