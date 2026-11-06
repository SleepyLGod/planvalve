"""Read-only installed LOTUS client check against the independent loopback gateway."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPO = Path(os.environ['GATEWAY_LOTUS_REPO']).resolve() if os.environ.get('GATEWAY_LOTUS_REPO') else None
CACHE = ROOT / '.client-cache'
CACHE.mkdir(exist_ok=True)
tempfile.tempdir = str(CACHE)
os.chdir(ROOT)
sys.dont_write_bytecode = True
# Do not inherit provider secrets, proxy settings, Codex paths, or dotenv discovery.
for key in list(os.environ):
    if any(value in key.upper() for value in ['API_KEY', 'ACCESS_TOKEN', 'REFRESH_TOKEN', 'PROXY']):
        os.environ.pop(key)
os.environ.update({
    'LITELLM_MODE': 'PRODUCTION', 'LITELLM_LOCAL_MODEL_COST_MAP': 'True',
    'PYTHON_DOTENV_DISABLED': '1', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
    'HF_HOME': str(CACHE / 'hf'), 'TORCH_HOME': str(CACHE / 'torch'),
    'MPLCONFIGDIR': str(CACHE / 'matplotlib'), 'XDG_CACHE_HOME': str(CACHE),
    'OPENAI_BASE_URL': sys.argv[1] + '/v1', 'OPENAI_API_KEY': 'offline-client-not-a-real-key',
})
denials: list[str] = []
connections: list[str] = []

def audit(event: str, args: tuple[object, ...]) -> None:
    """Allow only local sockets and writes inside the independent project."""
    if event == 'socket.getaddrinfo':
        if args[0] not in {'127.0.0.1', '::1'}:
            denials.append('external-dns')
            raise PermissionError('OFFLINE_NETWORK_DENIED: DNS')
    if event in {'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.getnameinfo'}:
        denials.append('dns-resolver-disabled')
        raise PermissionError('OFFLINE_NETWORK_DENIED: DNS resolver')
    if event == 'socket.sendto':
        denials.append('udp-disabled')
        raise PermissionError('OFFLINE_NETWORK_DENIED: UDP')
    if event == 'socket.connect':
        address = args[1]
        if not isinstance(address, tuple) or address[0] not in {'127.0.0.1', '::1'}:
            denials.append('non-loopback-network')
            raise PermissionError('OFFLINE_NETWORK_DENIED')
        connections.append(str(address))
    if event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)):
        path = Path(os.fsdecode(args[0])).absolute()
        if '.codex' in path.parts or path.name.startswith('.env'):
            denials.append(f'protected-read:{path.name}')
            raise PermissionError('Protected configuration read denied')
        flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            if path != Path('/dev/null') and not path.is_relative_to(ROOT):
                denials.append(f'external-write:{path}')
                raise PermissionError('External writes denied')
    if event in {'os.mkdir', 'os.rename', 'os.remove', 'os.rmdir'}:
        paths = args[:2] if event == 'os.rename' else args[:1]
        for value in paths:
            if isinstance(value, (str, bytes, os.PathLike)):
                path = Path(os.fsdecode(value)).absolute()
                if not path.is_relative_to(ROOT):
                    denials.append(f'external-mutation:{path}')
                    raise PermissionError('External mutation denied')
        if event in {'os.remove', 'os.rmdir'}:
            raise PermissionError('Deletion disabled in client check')

sys.addaudithook(audit)

def snapshot() -> dict[str, object] | None:
    """Fingerprint source/control files and metadata of all dependency files."""
    if REPO is None:
        return None
    status = subprocess.run(['/usr/bin/git','-C',str(REPO),'status','--porcelain=v1','--untracked-files=all'],check=True,capture_output=True,text=True,env={'PATH':'/usr/bin:/bin','GIT_OPTIONAL_LOCKS':'0'}).stdout
    hashes: dict[str,str] = {}
    for directory in [REPO / 'src', REPO / 'tests']:
        for path in directory.rglob('*.py'):
            hashes[str(path.relative_to(REPO))] = hashlib.sha256(path.read_bytes()).hexdigest()
    for name in ['pyproject.toml','uv.lock']:
        hashes[name] = hashlib.sha256((REPO / name).read_bytes()).hexdigest()
    deps = {}
    for path in (REPO / '.venv').rglob('*'):
        if path.is_file():
            stat = path.stat()
            deps[str(path.relative_to(REPO))] = (stat.st_size,stat.st_mtime_ns)
    return {'git_status':status,'source_sha256':hashes,'dependency_metadata':deps}

before = snapshot()
import lotus
import litellm
from lotus.models import LM
from lotus.cache import InMemoryCache
litellm.telemetry = False
lotus.settings.configure(enable_cache=False)
model = LM(model='openai/offline-model',cache=InMemoryCache(max_size=1),max_batch_size=1,num_retries=0)
# Standard installed LOTUS LM -> installed LiteLLM -> HTTP; no agent_memory imports.
output = model([[{'role':'system','content':'Return JSON.'},{'role':'user','content':'Compute 1+1.'}]],show_progress_bar=False,response_format={'type':'json_object'})
assert json.loads(output.outputs[0]) == {'answer':2}
assert (model.stats.physical_usage.prompt_tokens,model.stats.physical_usage.completion_tokens,model.stats.physical_usage.total_tokens) == (58,13,71)
# Exercise a real native semantic operator as well, without changing its prompts.
import pandas as pd
lotus.settings.configure(lm=model,enable_cache=False)
frame = pd.DataFrame({'question':['1+1']})
mapped = frame.sem_map('Compute {question}; return JSON with an integer answer.',suffix='_answer')
assert json.loads(mapped['_answer'].iloc[0]) == {'answer':2}
assert model.stats.physical_usage.total_tokens == 142
assert model.stats.cache_hits == 0
# Also exercise the ordinary official Python SDK without LOTUS conversion.
from openai import OpenAI
sdk = OpenAI(api_key='offline-client-not-a-real-key', base_url=sys.argv[1] + '/v1', max_retries=0)
sdk_result = sdk.chat.completions.create(model='offline-model', messages=[{'role':'user','content':'Return JSON.'}], response_format={'type':'json_object'})
assert json.loads(sdk_result.choices[0].message.content) == {'answer': 2}
assert sdk_result.usage is not None and sdk_result.usage.total_tokens == 71
sdk.close()
assert not denials, denials
assert snapshot() == before, 'Original repository or dependency metadata changed'
result = {'passed':True,'mode':'offline-only','lotus_lm_output':output.outputs[0],'native_sem_map_output':mapped['_answer'].iloc[0], 'usage_per_call':{'input':58,'output':13,'total':71},'calls':3,'lotus_calls':2,'official_python_sdk_usage':sdk_result.usage.model_dump(),'repo_source_and_dependencies_unchanged':True if REPO is not None else None,'external_network_attempts':denials,'loopback_connections':len(connections),'codex_config_read':False}
(ROOT/'reports/lotus-client.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False))
