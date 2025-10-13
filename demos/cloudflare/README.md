# Cloudflare Worker Demo

This demo uses a Cloudflare Worker to demonstrate how to block and monetize bots for a publisher site. The worker logic blocks all traffic unless valid credentials are provided, and logs all events to Supertab Connect.


 using [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

 The Deployed Demo is on [https://sbx.relgarem.workers.dev/](https://sbx.relgarem.workers.dev/)

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/get-started/) installed (`npm install -g wrangler`)
- Node.js installed

## Setup

1. **Environment Variables**

    Create a `.dev.vars` file in the project root with the following content:

    ```env
    MERCHANT_API_KEY=stc_live_cyysbuP9nXQmQkgn-5vrhUr4lEWm_702
    MERCHANT_SYSTEM_ID=test
    ```

    > **How to get these values:**
    > - Run the application and dashboards locally.
    > - Register as a merchant.
    > - Create a merchant system to get the `MERCHANT_SYSTEM_ID`.
    > - Create an API key from the dashboard to get the `MERCHANT_API_KEY`.

2. **Run the Worker Locally**

    Start the worker with:

    ```sh
    wrangler dev
    ```

    The worker will be available at [http://localhost:8787](http://localhost:8787).

## Testing the Worker

You can test the worker both with and without credentials:

### 1. Test Without Credentials

This should be blocked by the worker:

```sh
curl -H "" http://127.0.0.1:8787
```

### 2. Test With a Valid Customer System Token

To access content as a customer, follow these steps:

#### a. Register as a Customer

- Sign up via the customer dashboard to get your **customer URN**.

#### b. Create a Customer System

- In the dashboard, create a new customer system.

#### c. Create a Customer System Key

- Generate a key for your customer system.
- **Save the private key and KID (Key ID)** when shown—you won't be able to retrieve the private key again.

#### d. Generate a JWT Token

Use your private key and KID to generate a JWT token. Example in Python:

```python
import jwt
from datetime import UTC, datetime, timedelta

payload = {
    "iss": "<your_customer_urn>",
    "sub": "bot_a",
    "jti": "1234567890",
    "iat": int(datetime.now(tz=UTC).timestamp()),
    "exp": int((datetime.now(tz=UTC) + timedelta(hours=1)).timestamp()),
}
token = jwt.encode(
    payload,
    "<your_private_key>",
    algorithm="RS256",
    headers={"kid": "<your_kid>"}
)
print(token)
```

#### e. Call the Worker with Your Token

Replace `<token>` with the JWT you generated:

```sh
curl -H "Authorization: Bearer <token>" http://localhost:8787
```

If the token is valid, you should get access to the protected content.
