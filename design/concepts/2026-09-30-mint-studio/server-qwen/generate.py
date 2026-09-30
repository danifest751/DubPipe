"""Генерация двух макетов исходными промптами через домашний ComfyUI."""
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = os.environ.get('COMFYUI_URL', 'http://127.0.0.1:8188').rstrip('/')
OUT = Path(__file__).resolve().parent


def request(path, data=None):
    body = json.dumps(data).encode('utf-8') if data is not None else None
    req = urllib.request.Request(BASE + path, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=45) as response:
        return json.load(response)


def graph(prompt, name, seed):
    return {
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'qwen_image_2512_fp8_e4m3fn.safetensors', 'weight_dtype': 'default'}},
        '2': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['1', 0], 'lora_name': 'Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors', 'strength_model': 1.0}},
        '3': {'class_type': 'ModelSamplingAuraFlow', 'inputs': {'model': ['2', 0], 'shift': 3.1}},
        '4': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'type': 'qwen_image', 'device': 'default'}},
        '5': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'qwen_image_vae.safetensors'}},
        '6': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['4', 0], 'text': prompt}},
        '7': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['4', 0], 'text': ''}},
        '8': {'class_type': 'EmptySD3LatentImage', 'inputs': {'width': 1536, 'height': 960, 'batch_size': 1}},
        '9': {'class_type': 'KSampler', 'inputs': {'model': ['3', 0], 'positive': ['6', 0], 'negative': ['7', 0], 'latent_image': ['8', 0], 'seed': seed, 'steps': 4, 'cfg': 1.0, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1.0}},
        '10': {'class_type': 'VAEDecode', 'inputs': {'samples': ['9', 0], 'vae': ['5', 0]}},
        '11': {'class_type': 'SaveImage', 'inputs': {'images': ['10', 0], 'filename_prefix': 'dubpipe-design/2026-09-30/' + name}},
    }


def main():
    source = (OUT.parent / 'prompts.md').read_text(encoding='utf-8')
    home, studio = source.split('## Главный экран\n\n', 1)[1].split('\n\n## Экран дубляжа\n\n', 1)
    jobs = []
    for name, prompt, seed in [('01-library', home.strip(), 930261), ('02-dubbing', studio.strip(), 930262)]:
        workflow = graph(prompt, name, seed)
        (OUT / (name + '-workflow.json')).write_text(json.dumps(workflow, ensure_ascii=False, indent=2), encoding='utf-8')
        submitted = request('/prompt', {'prompt': workflow, 'client_id': 'dubpipe-design-20260930'})
        if submitted.get('node_errors'):
            raise RuntimeError(submitted['node_errors'])
        job = {'name': name, 'prompt_id': submitted['prompt_id'], 'seed': seed}
        jobs.append(job)
        (OUT / 'jobs.json').write_text(json.dumps(jobs, indent=2), encoding='utf-8')
        print(json.dumps({'submitted': job}), flush=True)
    deadline = time.monotonic() + 1800
    pending = list(jobs)
    while pending and time.monotonic() < deadline:
        for job in list(pending):
            entry = request('/history/' + job['prompt_id']).get(job['prompt_id'])
            if not entry:
                continue
            if entry.get('status', {}).get('status_str') == 'error':
                (OUT / (job['name'] + '-error.json')).write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding='utf-8')
                raise RuntimeError('ComfyUI failed for ' + job['name'])
            images = [img for node in entry.get('outputs', {}).values() for img in node.get('images', [])]
            if not images:
                continue
            for index, img in enumerate(images):
                suffix = '' if index == 0 else '-' + str(index)
                target = OUT / (job['name'] + suffix + '.png')
                with urllib.request.urlopen(BASE + '/view?' + urllib.parse.urlencode(img), timeout=60) as response:
                    target.write_bytes(response.read())
                job['output'] = target.name
                job['server_image'] = img
                print(json.dumps({'completed': job}), flush=True)
            (OUT / (job['name'] + '-history.json')).write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding='utf-8')
            pending.remove(job)
        if pending:
            time.sleep(4)
    (OUT / 'jobs.json').write_text(json.dumps(jobs, indent=2), encoding='utf-8')
    if pending:
        raise TimeoutError('Generation continues on server; prompt IDs saved in jobs.json')


if __name__ == '__main__':
    main()
