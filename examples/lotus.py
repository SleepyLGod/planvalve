"""Use an already installed LOTUS environment with the local gateway."""
import os
import pandas as pd
import lotus
from lotus.models import LM


def main() -> None:
    """Perform one small semantic map through the configured gateway."""
    lm = LM(
        model=f"openai/{os.environ.get('MODEL', 'offline-model')}",
        api_base="http://127.0.0.1:8787/v1",
        api_key=os.environ.get("GATEWAY_LOCAL_API_KEY", "offline-test"),
        num_retries=0,
    )
    lotus.settings.configure(lm=lm, enable_cache=False)
    frame = pd.DataFrame({"question": ["What is 1+1?"]})
    print(frame.sem_map("Answer {question}"))


if __name__ == "__main__":
    main()
