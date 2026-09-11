import { describe, it, expect, vi, afterEach } from "vitest";
import { hostRSLicenseXML } from "../src/license";

const BASE_URL = "https://api-connect.test";
const URN = "urn:merchant-system:abc";
const LICENSE_URL = `${BASE_URL}/merchants/systems/${URN}/license.xml`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hostRSLicenseXML", () => {
  it("serves the license XML the API returns", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<rsl />", { status: 200 })));

    const response = await hostRSLicenseXML(BASE_URL, URN);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/rsl+xml");
    await expect(response.text()).resolves.toBe("<rsl />");
  });

  it("names the Fastly backend in the 502 when the fetch throws on Fastly", async () => {
    // An unknown backend name is the likeliest cause, and Fastly throws rather than responding.
    vi.stubGlobal("fastly", {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("backend does not exist"));
    vi.stubGlobal("fetch", fetchMock);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await hostRSLicenseXML(BASE_URL, URN);

    // Asserted on the fetch itself, not just the error text: dropping the backend option
    // would still produce the same message while breaking the actual call.
    expect(fetchMock.mock.calls[0][1].backend).toBe("stc-backend");
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toContain('Fastly backend "stc-backend"');
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`could not fetch ${LICENSE_URL} via Fastly backend "stc-backend"`),
      expect.any(Error)
    );
  });

  it("omits the backend from the 502 when not running on Fastly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await hostRSLicenseXML(BASE_URL, URN);

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain("Fastly");
    expect(body).not.toContain("stc-backend");
  });

  it("logs the upstream status behind the 404 so a 401 is not read as a missing license", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await hostRSLicenseXML(BASE_URL, URN);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("License not found");
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`${LICENSE_URL} returned 401`)
    );
  });
});
