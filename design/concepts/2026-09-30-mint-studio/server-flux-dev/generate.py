"""Два исходных промпта через FLUX.2 dev с кэшированием кондиционирования."""
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = os.environ.get('COMFYUI_URL', 'http://127.0.0.1:8188').rstrip('/')
OUT = Path(__file__).resolve().parent
RUN = 'dubpipe_20260930_' + str(int(time.time()))


def request(path, data=None):
    body = json.dumps(data).encode('utf-8') if data is not None else None
    req = urllib.request.Request(BASE + path, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def save(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def submit(name, graph):
    save(name + '-workflow.json', graph)
    result = request('/prompt', {'prompt': graph, 'client_id': RUN})
    if result.get('node_errors'):
        raise RuntimeError(result['node_errors'])
    job = {'name': name, 'prompt_id': result['prompt_id']}
    print(json.dumps({'submitted': job}), flush=True)
    return job


def wait(job):
    deadline = time.monotonic() + 2400
    while time.monotonic() < deadline:
        entry = request('/history/' + job['prompt_id']).get(job['prompt_id'])
        if entry:
            status = entry.get('status', {})
            if status.get('status_str') == 'error':
                save(job['name'] + '-error.json', entry)
                raise RuntimeError('ComfyUI failed: ' + job['name'])
            if status.get('completed'):
                save(job['name'] + '-history.json', entry)
                print(json.dumps({'finished': job}), flush=True)
                return entry
        time.sleep(4)
    raise TimeoutError('Prompt ID saved; generation may continue on server')


def node(kind, **inputs):
    return {'class_type': kind, 'inputs': inputs}


def render_graph(name, seed, cache):
    return {
        '1': node('UnetLoaderGGUF', unet_name='flux2-dev-Q3_K_M.gguf'),
        '2': node('LoraLoaderModelOnly', model=['1', 0], lora_name='Flux2TurboComfyv2.safetensors', strength_model=1.0),
        '3': node('CondCacheLoad', name=cache),
        '4': node('FluxGuidance', conditioning=['3', 0], guidance=2.5),
        '5': node('BasicGuider', model=['2', 0], conditioning=['4', 0]),
        '6': node('RandomNoise', noise_seed=seed),
        '7': node('KSamplerSelect', sampler_name='euler'),
        '8': node('Flux2Scheduler', steps=8, width=1536, height=960),
        '9': node('EmptyFlux2LatentImage', width=1536, height=960, batch_size=1),
        '10': node('SamplerCustomAdvanced', noise=['6', 0], guider=['5', 0], sampler=['7', 0], sigmas=['8', 0], latent_image=['9', 0]),
        '11': node('VAELoader', vae_name='flux2-vae.safetensors'),
        '12': node('VAEDecode', samples=['10', 0], vae=['11', 0]),
        '13': node('SaveImage', images=['12', 0], filename_prefix='dubpipe-design/2026-09-30-flux-dev/' + name),
    }


def main():
    source = (OUT.parent / 'prompts.md').read_text(encoding='utf-8')
    home, studio = source.split('## Главный экран\n\n', 1)[1].split('\n\n## Экран дубляжа\n\n', 1)
    prompts = [('01-library', home.strip(), 930261), ('02-dubbing', studio.strip(), 930262)]
    encoder = {'1': node('CLIPLoader', clip_name='mistral_3_small_flux2_fp8.safetensors', type='flux2', device='default')}
    for index, (name, prompt, seed) in enumerate(prompts):
        text_id, save_id = str(2 + index * 2), str(3 + index * 2)
        encoder[text_id] = node('CLIPTextEncode', clip=['1', 0], text=prompt)
        encoder[save_id] = node('CondCacheSave', conditioning=[text_id, 0], name=RUN + '_' + name)
    jobs = [submit('00-encode', encoder)]
    save('jobs.json', jobs)
    wait(jobs[0])
    for name, prompt, seed in prompts:
        job = submit(name, render_graph(name, seed, RUN + '_' + name))
        job['seed'] = seed
        jobs.append(job)
        save('jobs.json', jobs)
    for job in jobs[1:]:
        entry = wait(job)
        images = [img for output in entry.get('outputs', {}).values() for img in output.get('images', [])]
        if not images:
            raise RuntimeError('No image: ' + job['name'])
        for index, img in enumerate(images):
            filename = job['name'] + ('' if index == 0 else '-' + str(index)) + '.png'
            with urllib.request.urlopen(BASE + '/view?' + urllib.parse.urlencode(img), timeout=60) as response:
                (OUT / filename).write_bytes(response.read())
            job['output'] = filename
            job['server_image'] = img
            print(json.dumps({'downloaded': filename}), flush=True)
        save('jobs.json', jobs)


if __name__ == '__main__':
    main()
