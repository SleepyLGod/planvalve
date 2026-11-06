"""Call the saved local gateway once through LiteLLM, without copying keys."""
from __future__ import annotations

import argparse
import json
import os


def main() -> None:
    """Read existing local settings, make one request and print text plus usage."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", action="store_true", required=True, help="Use this project's saved model, address and local client key; sends one request")
    parser.parse_args()

    # Reuse the protected reader, not the subscription credentials or SDK main().
    from client import local_connection

    base_url, local_key, model = local_connection()
    os.environ["LITELLM_MODE"] = "PRODUCTION"
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    import httpx
    import litellm
    from openai import OpenAI

    litellm.telemetry = False
    litellm.suppress_debug_info = True
    with OpenAI(
        api_key=local_key,
        base_url=base_url,
        max_retries=0,
        http_client=httpx.Client(trust_env=False, follow_redirects=False),
    ) as client:
        response = litellm.completion(
            model=f"openai/{model}",
            api_base=base_url,
            api_key=local_key,
            client=client,
            messages=[{"role": "user", "content": "Return JSON with answer equal to 2."}],
            response_format={"type": "json_object"},
            num_retries=0,
        )
    print(json.dumps({"text": response.choices[0].message.content, "usage": response.usage.model_dump(exclude_none=True)}))


if __name__ == "__main__":
    main()
