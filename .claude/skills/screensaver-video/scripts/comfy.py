"""Minimal ComfyUI API driver (stdlib only). Verified against ComfyUI 0.31.0.

Usage:
  python comfy.py run <workflow.json>            # submit API-format graph, poll until done
  python comfy.py upload <local.png> <name.png>  # put an image in ComfyUI's input folder
  python comfy.py download <fname> <subfolder> <type> <dest>   # fetch from output folder
"""
import json, sys, time, uuid, urllib.request, urllib.parse

HOST = "http://192.168.1.95:8188"

def post_prompt(prompt):
    data = json.dumps({"prompt": prompt, "client_id": str(uuid.uuid4())}).encode()
    req = urllib.request.Request(HOST + "/prompt", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.load(r)
    if resp.get("node_errors"):
        print(json.dumps(resp, indent=1)); sys.exit(1)
    return resp["prompt_id"]

def wait(pid, timeout=3600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        with urllib.request.urlopen(f"{HOST}/history/{pid}", timeout=30) as r:
            h = json.load(r)
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print(json.dumps(h[pid], indent=1)[:4000]); sys.exit(2)
            if st.get("completed"):
                return h[pid]["outputs"]
        time.sleep(10)
    print("TIMEOUT"); sys.exit(3)

def download(fname, sub, ftype, dest):
    q = urllib.parse.urlencode({"filename": fname, "subfolder": sub, "type": ftype})
    with urllib.request.urlopen(f"{HOST}/view?{q}", timeout=300) as r, open(dest, "wb") as f:
        f.write(r.read())

def upload(path, name):
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        blob = f.read()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + blob + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(HOST + "/upload/image", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "run":
        pid = post_prompt(json.load(open(sys.argv[2])))
        print("prompt_id", pid, flush=True)
        print(json.dumps(wait(pid), indent=1))
    elif cmd == "upload":
        print(upload(sys.argv[2], sys.argv[3]))
    elif cmd == "download":
        download(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        print("saved", sys.argv[5])
