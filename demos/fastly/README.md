# Fastly Compute Demo

This demo uses a Fastly Compute service to demonstrate how to block and monetize bots for a publisher site. The service logic blocks all traffic unless valid credentials are provided, and logs all events to Supertab Connect.

The Deployed Demo is on [https://stc-fastly-demo.edgecompute.app/](https://stc-fastly-demo.edgecompute.app/)

## Prerequisites

- [Fastly CLI](https://developer.fastly.com/learning/compute/) installed (`npm install -g @fastly/cli`)
- Node.js installed

## Setup

1. **Environment Variables**

   For local development, the environment variables are stored in the `config.js` file. Edit this file with your credentials:

   ```js
   // src/config.js
   export const CONFIG = {
     MERCHANT_SYSTEM_ID: "test",
     MERCHANT_API_KEY: "your_api_key_here",
   };


> Note: Using config.js was the solution found to make environment variables work in Fastly's local development environment. In production, these values are stored in Fastly's Secret Store.

> How to get these values:
> - Run the application and dashboards locally.
> - Register as a merchant.
> - Create a merchant system to get the MERCHANT_SYSTEM_ID.
> - Create an API key from the dashboard to get the MERCHANT_API_KEY.


2. **Run the Service Locally**

   Start the Fastly Compute service with:

   ```sh
   fastly compute serve

The service will be available at http://127.0.0.1:7676.



# Testing the Service
You can test the service both with and without credentials:

### 1. Test Without Credentials

This should be blocked by the service:

```sh
curl -H "" http://127.0.0.1:7676
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
curl -H "Authorization: Bearer <token>" http://localhost:7676
```

If the token is valid, you should get access to the protected content.


## Deployment
For production deployment, use:

```sh
fastly compute deploy
```
