// Intake form: photos -> Supabase Storage (private bucket), record -> submit_intake() RPC.
// Plain fetch against Supabase REST so there is no client library or bundler.
(() => {
  const cfg = JSON.parse(document.getElementById("cfg").textContent);
  const MAX_PHOTOS = 8;
  const MAX_EDGE = 1600;
  const $ = (id) => document.getElementById(id);
  const form = $("intake"), input = $("photos"), list = $("previews"), errEl = $("error"), btn = $("submit");

  /** @type {{file: File, url: string}[]} */
  let photos = [];

  function showError(msg) { errEl.textContent = msg; errEl.hidden = !msg; if (msg) errEl.scrollIntoView({ block: "center" }); }

  function render() {
    list.innerHTML = "";
    photos.forEach((p, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<img alt=""><div class="pctl"></div>`;
      li.querySelector("img").src = p.url;
      const ctl = li.querySelector(".pctl");
      if (i === 0) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "Hero"; ctl.append(t); }
      else { const b = document.createElement("button"); b.type = "button"; b.textContent = "Make hero"; b.onclick = () => { photos.unshift(photos.splice(i, 1)[0]); render(); }; ctl.append(b); }
      const x = document.createElement("button"); x.type = "button"; x.textContent = "Remove"; x.onclick = () => { URL.revokeObjectURL(p.url); photos.splice(i, 1); render(); }; ctl.append(x);
      list.append(li);
    });
  }

  input.addEventListener("change", () => {
    for (const file of input.files) {
      if (photos.length >= MAX_PHOTOS) { showError(`Up to ${MAX_PHOTOS} photos.`); break; }
      photos.push({ file, url: URL.createObjectURL(file) });
    }
    input.value = "";
    render();
  });

  // Downscale phone photos (often 4-12MB) to JPEG. Falls back to the original if the browser can't decode (e.g. HEIC outside Safari).
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
      if (blob) return { blob, ext: "jpg", type: "image/jpeg" };
    } catch (_) {}
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    return { blob: file, ext: ["jpg", "jpeg", "png", "webp", "heic"].includes(ext) ? ext : "jpg", type: file.type || "image/jpeg" };
  }

  const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
  const headers = { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` };

  async function upload(folder, i, file) {
    const { blob, ext, type } = await shrink(file);
    // Non-guessable: random folder (uuid) + random file token. Bucket is private; nothing can list or read it publicly.
    const path = `${folder}/${i}-${rand(8)}.${ext}`;
    const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/intake-photos/${path}`, {
      method: "POST", headers: { ...headers, "Content-Type": type, "x-upsert": "false" }, body: blob,
    });
    if (!res.ok) throw new Error("Photo upload failed. Please try again.");
    return path;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    if (form.website.value) return; // honeypot
    if (!photos.length) return showError("Add at least one photo.");
    if (!form.reportValidity()) return;

    const fd = new FormData(form);
    const v = (k) => (fd.get(k) || "").toString().trim();
    btn.disabled = true;
    try {
      let ref;
      if (!cfg.supabaseUrl) { // dev mode: no backend configured
        await new Promise((r) => setTimeout(r, 500));
        ref = "intake-0000";
      } else {
        const folder = crypto.randomUUID();
        const paths = [];
        for (let i = 0; i < photos.length; i++) {
          btn.textContent = `Uploading photo ${i + 1} of ${photos.length}…`;
          paths.push(await upload(folder, i, photos[i].file)); // order preserved: first = hero
        }
        btn.textContent = "Saving…";
        const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/submit_intake`, {
          method: "POST", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            p_customer_name: v("customer_name"), p_title: v("title"), p_description: v("description"),
            p_condition: v("condition"), p_model_number: v("model_number"), p_works: v("works"),
            p_damage: v("damage"), p_included: v("included"), p_photo_paths: paths,
          }),
        });
        if (!res.ok) throw new Error("Couldn't save your item. Please try again.");
        ref = await res.json();
      }
      $("ref").textContent = ref;
      $("messenger").href = `https://m.me/${encodeURIComponent(cfg.pageName)}?ref=${encodeURIComponent(ref)}`;
      $("form-view").hidden = true; $("done-view").hidden = false;
      window.scrollTo(0, 0);
    } catch (err) {
      showError(err.message || "Something went wrong. Please try again.");
      btn.disabled = false; btn.textContent = "Upload item";
    }
  });
})();
