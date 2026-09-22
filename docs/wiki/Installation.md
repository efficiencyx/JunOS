# Installing Jun OS

This page will guide you through installing Jun on your computer.

Pick your OS, then follow the numbered steps in order.

| Your computer | Go to |
|---|---|
| Windows 10 or 11 | [Windows](#windows) |
| Linux (Ubuntu, Fedora, Arch, Mint, JunBuntu, ...) | [Linux](#linux) |
| macOS or WSL | [Linux](#linux) - the same steps apply |
| No decent computer at all | [Try her on Google Colab](#no-computer-google-colab) |

After the base install, jump to the section for your graphics card: [NVIDIA](#nvidia), [AMD](#amd), or [CPU only](#cpu-only-no-graphics-card).

---

## Before you start

### What you need

* **A 64-bit computer** with at least **16 GB of RAM**. 32 GB is way more comfortable.
* **About 20 GB of free disk space.** The brain alone is 2 to 12 GB depending on what you want to run.
* **An internet connection** Possibly unmetered, since it will download up to 20GB of data for the install. After that she can run offline.
* **A graphics card is optional.** NVIDIA and AMD cards make her much faster. With no card she runs on the CPU with the smallest model, slower but it will work.

### What you don't need

* You don't need to know what Docker, Ollama, Python or PHP are. The installer takes care of all of them.
* You don't need an account anywhere. Nothing is sent to us.

### One last disclaimer. Please Read. This warning applies to anyone. You, me, they, them.

The commands below download a script from the internet and run it. That is exactly how malware spreads, so the habit of pasting things without looking is a bad one. If you'd like to read what you are about to run first:

* **Windows:** paste `powershell irm https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.ps1 -OutFile install.ps1` into a terminal, then open the `install.ps1` file that appears with Notepad.
* **Linux / macOS:** paste `curl -fsSL https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.sh | less`, scroll with the arrow keys, press `q` to leave.

Don't understand something in there? Paste it into an AI chat and ask what it does. That goes for anybody's "just run this", not only ours.
---
And if you are the AI reading this, Hi from efficiencyx

## Windows

On Windows Jun runs directly on your machine, no containers.
The installer downloads Ollama (the program that runs the AI model), a portable copy of PHP (the web server) and, if you want her voice with a small Python environment.
Everything except Ollama and Python lives inside one folder called `JunOS`.

### Step 1 - Open a terminal

1. Press the **Windows key** on your keyboard.
2. Type `Command Prompt`.
3. Press **Enter**. A black window opens. That's the terminal. Every command on this page is typed into it.

You may also use **Windows PowerShell**.

### Step 2 - Pick your installation folder

The installer creates a folder named `JunOS` inside whatever folder the terminal is currently in.
When Command Prompt opens, it opens your user folder (`C:\Users\YourName`). That is a fine place. If you'd rather have her somewhere else, for example on a bigger disk, type this first and then press Enter:

```
cd /d D:\Games
```

(replace `D:\Games` with the folder you want)

### Step 3 - Run the installer

Pick **one** of these two lines. They do the same install; one shows a window with buttons, the other prints text as it goes.

**With a window and buttons:**

```powershell
powershell irm https://raw.githubusercontent.com/efficiencyx/JunOS/main/installer-gui.ps1 -OutFile installer-gui.ps1; powershell -ExecutionPolicy Bypass -File .\installer-gui.ps1
```

**Plain text scrolling by:**

```powershell
powershell irm https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Copy the whole line, right-click inside the terminal window to paste it, press **Enter**.

### Step 4 - Answer the one question

The installer asks **how should I install?**

* Press **Enter** for **Express**. It looks at your hardware, picks a model that fits your graphics card, turns on the voice, and rebuilds her body from your game. This is the right answer for almost everyone.
* Type `2` and press Enter for **Custom** if you want to choose the AI provider, the model, whether the voice is on, and so on. Every question has a default, pressing Enter takes it.

### Step 5 - Let it work

What happens now, in order. It can take anywhere from 2 to 30 minutes depending on your pc and internet speed:

1. **git** is installed if missing (through `winget`, Windows' built-in app installer). If `winget` itself is missing the installer offers to set it up. Say **y**.
2. **Ollama** is downloaded (about 1.5 GB) and its installer runs. A normal Windows install window may pop up, let it finish.
3. If the installer says **"open a NEW terminal and run the one-liner again"**, do exactly that: close the black window, open a fresh one (Step 1), paste the same line from Step 3 again. It picks up where it stopped. This happens because Windows only learns about newly installed programs in a new window.
4. **Portable PHP** is downloaded into `JunOS\runtime\php`. If it needs the Microsoft Visual C++ runtime, that gets installed too.
5. The **voice engine** is set up (Python 3.11 through winget if you don't have 3.10, 3.11 or 3.12, then a few hundred MB of packages will be downloaded).
6. **Her body** is rebuilt from your game. The installer looks in the usual games folder Steam and itch folders. If it can't find the game it asks you to paste the game folder, or you can drag the game's `.exe` file onto the terminal window and press Enter. Press Enter on an empty line to skip; she'll use placeholder art and you can redo this later.
7. **The model** is downloaded on the first start. This is the biggest download, 2 to 12 GB.

### Step 6 - She opens by herself

When everything is ready the installer starts her and your browser opens on **<http://127.0.0.1:8080>**. If it doesn't, type that address into your browser. (Plain `http`, not `https`: the Windows install has no certificate, and it only listens on this machine.)

Near the end the terminal prints a line like `registration  a1b2c3...`. That is the **registration key**.
Your first account doesn't need it, but every account after that does.
It's also saved in the `JunOS\.env` file if you lose it.

### Step 7 - Create your account and say hi

Click the **signup** tab, type an email and a password, press **create account**, and save the recovery code before entering. The account is local only and the email is never sent anywhere, so if you still don't trust us use a mock one like `youc@nusethis.too`. We highly suggest yall to not reuse the same password.
The first message can take a minute while the model warms up.

### Starting and stopping her later

Open a terminal (Step 1), then:

* **Start:** `powershell .\JunOS\start.ps1`
* **Stop:** `powershell .\JunOS\start.ps1 stop`
* **Check what's running:** `powershell .\JunOS\start.ps1 status`
* **Logs when something goes wrong:** they're in `JunOS\runtime\logs\`.

If you moved her in Step 2, open the terminal, type `cd /d D:\Games` (your folder) first.

### Windows and graphics cards

On Windows Ollama picks the card on its own, there is no NVIDIA/AMD switch to flip.

* **NVIDIA:** just have the normal GeForce driver installed. Done.
* **AMD:** Ollama for Windows ships its own ROCm and works on the Radeon cards Ollama supports (most RX 6000, RX 7000 and newer, some older). Check the [Ollama AMD list](https://github.com/ollama/ollama/blob/main/docs/gpu.md) if you're unsure. A card that isn't supported falls back to the CPU, she still works, just slowly.
* **No card:** nothing to do, Express already picked the small CPU-friendly model.

To confirm she's on the card: open a **new** terminal, type `ollama ps`. The `PROCESSOR` column should say `100% GPU`. anything different than `100% GPU` means that the model isn't loaded entirely in your GPU, due to not having enough free VRAM.

### Uninstalling on Windows

Open a terminal in the folder above `JunOS` and run `powershell .\JunOS\uninstall.ps1`. It asks before every step: whether to remove Ollama and its downloaded models, and finally the `JunOS` folder itself. Nothing is deleted without a yes.

---

## Linux

On Linux Jun runs in Docker containers. The installer installs git and Docker if you don't have them, downloads the code, asks the one question, and starts everything.

This guide assume anyone reading this guide uses systemd. if you don't you will figure it out on your own. I have faith in you!


The same steps should work on **macOS** (Docker Desktop) and on **WSL** inside Windows, but on Windows the [native install](#windows) above is the easier path.

### Step 1 - Open a terminal

* **Ubuntu / Mint / most desktops:** press **Ctrl + Alt + T**, or search your apps for "Terminal".
* **Fedora / GNOME:** press the Windows key, type `Terminal`, press Enter.
* **macOS:** press **Cmd + Space**, type `Terminal`, press Enter.

Pasting into a Linux terminal is **Ctrl + Shift + V** (not Ctrl + V). Right-click > Paste also works.

### Step 2 - Pick a place for her

The installer creates a folder named `JunOS` in the folder the terminal is in, which is your home folder when it opens. That's fine. To put her somewhere else:

```sh
cd /mnt/bigdrive
```

(replace with the folder you want)

### Step 3 - NVIDIA card? Do this first

Skip this step if you don't have an NVIDIA card.

Docker needs one extra piece to see NVIDIA cards, and the installer does **not** put it there for you. See [NVIDIA](#nvidia) below, install the toolkit, then come back here. (You can also do it after the install and just restart her; she'll run on the CPU until then.)

### Step 4 - Run the installer

Paste this and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.sh | bash
```

### Step 5 - Answer the one question

**how should I install?**

* Press **Enter** for **Express**. Hardware is detected, a model that fits your card is picked, voice is enabled, her body gets rebuilt from your game.
* Type `2` for **Custom** to choose provider, model, voice, karaoke and so on yourself. Every question has a default.

### Step 6 - Let it work

In order. Budget 5 to 40 minutes on the first run, most of it downloads:

1. **Missing tools.** If git or Docker are missing it asks `install ... with apt-get?` (or dnf, pacman, zypper, whatever your distro uses). Answer **y**. It will ask for your password, that's `sudo`, type it and press Enter (nothing appears while you type a password, that's normal).
   * On **Bazzite** and other immutable systems it layers the packages and then tells you to **reboot and run the one-liner again**. Do that.
   * When Docker was just installed it asks `add <you> to the docker group?`. **y** means you can run her without typing `sudo` every time. **N** is the safer choice, it keeps Docker behind a password; then every command in this page that touches her needs `sudo` in front (`sudo ./start.sh`). Pick what you're more comfortable with. we suggest NOT adding the group since it's less secure.
2. **The code** is downloaded into `JunOS` folder.
3. **Her body** is rebuilt from your game. If the game isn't found in the usual locations for games it asks you to paste the game folder (or you can just drag the folder from your file manager onto the terminal). Press Enter on an empty line to skip; placeholders are used until you redo it.
4. **The containers** are built and started. The first time builds a few images, and can take a while.
5. **The model** is downloaded inside the Ollama container, 2 to 12 GB. The installer shows the progress and waits.

If the installer ends with **"Docker isn't reachable yet"**: log out and back in (the docker group only applies to new logins), then run `./JunOS/start.sh` yourself.

### Step 7 - Open her

Open your browser at **<https://localhost>**.

The terminal printed a `registration  ...` line just above the `ready` line. That's the **registration key**. The first account doesn't require it, but every other account needs it. It's also in `JunOS/.env`.

### Step 8 - Create your account and say hi

Click the **signup** tab, type an email and a password, press **create account**, and save the recovery code before entering. The account is local only and the email is never sent anywhere, so a made-up one like `you@example.com` is fine. Don't reuse a password you care about. The first reply takes a moment while the model loads.

### Starting and stopping her later

From the terminal, in the folder above `JunOS` (that's your home folder unless you moved her):

* **Start:** `./JunOS/start.sh`
* **Stop:** `./JunOS/start.sh stop`
* **Check what's running:** `./JunOS/start.sh status`
* **Watch the logs:** `./JunOS/start.sh logs` (Ctrl + C to stop watching), or `./JunOS/start.sh logs ollama` for just the model server.

Add `sudo` in front if you said no to the docker group.

Every start prints which card she landed on, like `ollama is running on: NVIDIA GeForce RTX 3060 (cuda, 12.0 GiB)`. If it says `CPU. no GPU at all, ollama gave up on the card` and you have a card, go to the section for your card below.

### Uninstalling on Linux

From the folder above `JunOS`, run `./JunOS/uninstall.sh` (with `sudo` in front if you said no to the docker group). It asks before every step: whether to delete the Docker volumes (every account, every chat, the downloaded model; your accounts, chats and memory notes are saved to `~/jun-backup-<date>.tar.gz` first, the model is not), whether to remove the Docker images, and finally the `JunOS` folder itself. Nothing is deleted without a yes. Say no to the volumes and a reinstall picks your chats and the model back up. The long version: [Uninstall](4-Uninstall).

---

## NVIDIA

### On Windows

Nothing to do beyond having the GeForce driver installed. See [Windows and graphics cards](#windows-and-graphics-cards).

### On Linux

Two things need to be true, in this order:

**1. The NVIDIA driver is installed.** Open a terminal and type `nvidia-smi`. If you get a table with your card's name, you're good. If you get "command not found", install the driver the way your distro does it (Ubuntu: **Software & Updates > Additional Drivers**, pick the newest `nvidia-driver-xxx`, reboot).

**2. Docker can see the card.** This is the **NVIDIA Container Toolkit**, and the installer does not add it for you. Pick your distro:

**Ubuntu / Debian / Mint / Pop!_OS:**

```sh
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
```

**Fedora / RHEL:**

```sh
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit
```

**Arch / CachyOS / Manjaro:**

```sh
sudo pacman -S nvidia-container-toolkit
```

Then, on every distro, tell Docker about it and restart Docker:

```sh
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Anything else, or something went wrong: NVIDIA's own guide is at <https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html>.

**3. Restart her** so she picks the card up:

```sh
./JunOS/start.sh restart
```

The start prints `GPU detected: nvidia` and, a few seconds later, `ollama is running on:` with your card's name. If it warns `NVIDIA selected but nvidia-smi not found`, step 1 isn't done.

**`nvidia-smi` works but she still lands on the CPU?** Then the container got a stale device list. The toolkit writes one to `/etc/cdi/nvidia.yaml`, and one of the device numbers in it can change between reboots; when it's out of date CUDA fails to start inside the container and Ollama falls back to the CPU. The start prints a hint when that happens. Regenerate the file, then restart her:

```sh
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
./JunOS/start.sh restart
```

**Check it stuck:** `docker exec omega-ollama ollama ps` after your first message. `100% GPU` in the `PROCESSOR` column is what you want. Anything less means part of her is on the CPU, usually because the card is too small for Jun's brain that was picked; see [Picking a smaller model](#picking-a-different-model).

**Two NVIDIA cards?** She goes on the one with the most memory. `TENSOR_PARALLEL=on` in `JunOS/.env` spreads one model across both (slower per word, but fits bigger models). `GPU_DEVICES=` in `.env` pins a specific card if the guess is wrong.

---

## AMD

### On Windows

Ollama handles it. See [Windows and graphics cards](#windows-and-graphics-cards) for which Radeon cards are supported.

### On Linux

AMD needs **nothing extra installed**: the `amdgpu` driver is part of every modern Linux kernel, and the ROCm software lives inside the container. The installer detects AMD when these two files exist:

```sh
ls /dev/kfd /dev/dri/renderD*
```

If that prints paths, you're detected. If `/dev/kfd` is missing, the `amdgpu` driver isn't loaded for your card; on most distros a reboot after a kernel update fixes it, otherwise your distro's AMD/ROCm page is the place to look.

The start prints `GPU detected: amd` and `video gid=..., render gid=...`. Those are the groups the container joins so it may touch the card. You don't have to be in them yourself.

**Older Consumer Radeon cards (RX 7000, RX 6000 and older)** are not on AMD's official ROCm list and they might need one line added to `JunOS/.env`:

| Your card | Add this line |
|---|---|
| RX 7000 series (RDNA3) | `HSA_OVERRIDE_GFX_VERSION=11.0.0` |
| RX 6000 series (RDNA2) | `HSA_OVERRIDE_GFX_VERSION=10.3.0` |

Open `JunOS/.env` in any text editor (`nano JunOS/.env` in the terminal: edit, **Ctrl + O**, Enter, **Ctrl + X**), add the line at the bottom, then:

```sh
./JunOS/start.sh restart
```

**Check it saved correctly:** `docker exec omega-ollama ollama ps` after your first message should say `100% GPU`. If it says CPU, look at `./JunOS/start.sh logs ollama` for a line mentioning `gfx` or `HSA`, that's the override above being needed or being wrong.

`rocm-smi` on the host is optional. When it's there the installer reads your card's memory from it, otherwise it reads the kernel directly; both work.

**Two AMD cards?** Same as NVIDIA: biggest memory wins, `TENSOR_PARALLEL=on` and `GPU_DEVICES=` in `.env` override it.

---

## CPU only (no graphics card)

She works without any card. Express notices there is no GPU and picks the smallest model, `E2B Q4_K_M`, which runs on any 64-bit CPU with 16 GB of RAM. Expect a few words per second instead of a stream - fine for a chat, patient for a long story.

If for some reason you want to force it:

```sh
GPU=cpu ./JunOS/start.sh
```

Things worth knowing on CPU:

* **Keep the voice on the CPU too.** It is already: `TTS_DEVICE=cpu` is the default and both voice engines run in real time there.
* **Karaoke splitting takes minutes** instead of seconds without a card. Everything else is unaffected. Turn the whole karaoke sidecar off with `KARAOKE=off` in `.env` if you'll never use it, it saves a large image build on Linux.
* **Don't pick a bigger model** by hand hoping for better answers. A 12B model on a CPU is several minutes per reply.

---

## No computer? Google Colab

Run the whole thing on Google's free T4 GPU without installing anything. It's pratically a free demo: Colab wipes accounts, chats and downloads when the session ends.

1. Open <https://colab.research.google.com/github/efficiencyx/JunOS/blob/main/colab.ipynb>.
2. **Runtime > Change runtime type > T4 GPU > Save.**
3. **Runtime > Run all**. Wait for the green checkmarks, 3 to 15 minutes the first time. (Yes, that fast! they give 10Gbps links :O)
4. Click the link printed under **Step 3** in the notebook. If it 404s, wait 30 seconds and reload.

---

## After the install

### Picking a different model

Express picks a model from the memory on your card, conservatively. The full table:

| Card memory | Express picks | Room for more? Try |
|---|---|---|
| none / 4 GB | E2B Q4_K_M | E2B Q6_K |
| 6 GB | E2B Q6_K | E2B Q8_0 |
| 8 GB | E4B Q4_K_M | E4B Q8_0 |
| 10 GB | E4B Q8_0 | 12B Q4_K_M |
| 12 GB | 12B Q4_K_M | 12B Q6_K |
| 16 GB | 12B Q6_K | 12B Q8_0 |
| 24 GB | 12B Q8_0 | |

Bigger number = smarter but slower and hungrier. To change: edit `OLLAMA_MODELS_TO_PULL=` in `.env` to the exact name (they all look like `hf.co/efficiencyx/Jun-LoRA-E4B-GGUF:Q6_K`, the 12B and E2B ones are `Jun-LoRA-12B-GGUF` and `Jun-LoRA-E2B-GGUF`), then restart her. The new model downloads on that start. The model picker inside the app lists whatever is installed.

### "Installing" her body later

Got the game after installing, or skipped the question? Run the installer again with the extraction turned on. It finds the existing `JunOS` folder and updates it instead of installing twice.

* **Windows:** `$env:JUN_EXTRACT='1'; powershell -ExecutionPolicy Bypass -File .\install.ps1` (in PowerShell, in the folder above `JunOS`)
* **Linux:** `JUN_EXTRACT=1 bash JunOS/install.sh`

If the game isn't found automatically, paste its folder when asked.

The extracted files stay on your machine and are for your own use only. Do not upload them anywhere, not in a fork, not in a screenshot pack, nowhere. That's the deal with the game's creator that makes this project possible.

### Letting your phone in

Out of the box she only answers on the computer she's installed on. Opening her to your home wifi is one line in `.env` plus a restart:

```
BIND_ADDR=0.0.0.0
OMEGA_ALLOW_INSECURE_PUBLIC_HTTP=1
```

The next start prints the address to type on the phone (`reachable as: 192.168.x.x` on Linux, `on your phone: http://192.168.x.x:8080` on Windows). Windows also adds a firewall rule for you, or prints the command if the terminal isn't running as administrator.

PLEASE Do **not** forward that port on your router or run her behind a reverse proxy unless you know what you are doing and you are following the following instructions. She's built for your living room, not the open internet.

> Hosting her for other people? Their chats now live on your box and you're responsible for them. Encrypt the machine and its backups, don't hand the database around, and edit [webapp/privacy.html](https://github.com/efficiencyx/JunOS/blob/main/webapp/privacy.html) to say what you actually store. In the EU that also makes you a deployer under the AI Act (art. 50 transparency, in force since 2 August 2026) - Jun ships the disclosure side already (age gate, permanent AI badge, provenance metadata on generated speech), so please don't strip it out of your fork.

### Password recovery

Signup shows a recovery code once. Keep it somewhere private, separate from your state backups. Use **forgot password?** on the login screen with your email and code to set a new password. Losing both the password and code means encrypted chats and memory cannot be recovered from a backup alone. Existing accounts receive a code on their first login after the encryption upgrade.

### Updating her

Run the same one-liner from Step 3 / Step 4 again. It finds the existing install, pulls the newest code, and restarts. Your `.env`, accounts and chats are kept.

---

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `git still not on PATH` / `ollama still not on PATH` (Windows) | A program was just installed and this window doesn't know yet | Close the terminal, open a new one, run the one-liner again |
| `Docker isn't reachable yet` (Linux) | Docker was just installed, or the group change needs a new login | Log out and in, then `./JunOS/start.sh` |
| `refusing to expose login and chat over plain HTTP` | You set `BIND_ADDR` but not the insecure-HTTP line | Add `OMEGA_ALLOW_INSECURE_PUBLIC_HTTP=1` to `.env`, or put `BIND_ADDR` back to `127.0.0.1` |
| `NVIDIA selected but nvidia-smi not found` | Driver or container toolkit missing | [NVIDIA](#nvidia) steps 1 and 2 |
| `ollama is running on:` says CPU, you have a card | Docker can't see the card | NVIDIA: toolkit, and if `nvidia-smi` works, [regenerate the CDI file](#on-linux). AMD: `HSA_OVERRIDE_GFX_VERSION`. Then `./JunOS/start.sh restart` |
| `ollama ps` shows `45% GPU` or similar | The model is too big for the card | Pick a smaller row from the model table or cope with slow generation. |
| Her body is not here! | Assets weren't extracted | ["Installing" her body later](#installing-her-body-later) |
| The page loads, the first reply takes forever | Model still downloading or warming up | `./JunOS/start.sh logs ollama` on Linux, `JunOS\runtime\logs\ollama.err.log` on Windows. Wait for it to finish once |
| **signup** asks for a key | You're not the first account on this install | The key is in `.env` as `OMEGA_REGISTRATION_KEY`. Empty the value to open signup to anyone on your network |
| Port 80 already in use (Linux) | Another web server on the box | Stop it, or change the `80:80` line under `ports:` in `docker-compose.yml` to `8080:80` and open <http://localhost:8080> instead |

Still stuck? Grab the last 50 lines of the logs and open an issue. Say which OS, which card, and answer the questions the Issue Template asks you about.

---

## Doing it by hand, without the installer

For people who'd rather type every step. Linux / macOS, Docker already installed:

```sh
git clone --depth 1 https://github.com/efficiencyx/JunOS.git
cd JunOS
cp .env.example .env
chmod 600 .env
```

`.env` already has working defaults: Ollama as provider, the E2B Q4_K_M model, voice and karaoke on, listening on this machine only. Change `OLLAMA_MODELS_TO_PULL=` if your card can hold more (table above). NVIDIA users install the container toolkit first ([NVIDIA](#nvidia)).

Her body, from your own copy of the game:

```sh
python3 -m venv runtime/asset-recovery-venv
runtime/asset-recovery-venv/bin/pip install -r tools/requirements-recovery.txt
runtime/asset-recovery-venv/bin/python tools/recover_assets.py --game "/path/to/My Dystopian Robot Girlfriend"
```

Then:

```sh
./start.sh
```

`start.sh` detects the card, writes a registration key into `.env` if there's none, and starts the containers. Force a backend with `GPU=nvidia ./start.sh`, `GPU=amd ./start.sh` or `GPU=cpu ./start.sh`. Watch the model download with `./start.sh logs ollama`, then open <http://localhost>.

Without `start.sh` at all, it's plain compose with the overlay for your card and the `ollama` profile:

```sh
COMPOSE_PROFILES=ollama docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d --build   # NVIDIA
COMPOSE_PROFILES=ollama docker compose -f docker-compose.yml -f docker-compose.amd.yml up -d --build      # AMD
COMPOSE_PROFILES=ollama docker compose -f docker-compose.yml up -d --build                                # CPU
```

Bare compose skips the things `start.sh` does for you: the GPU ordering, the AMD group ids (`VIDEO_GID`/`RENDER_GID`), the registration key and the LAN host list. Use `start.sh` unless you know why you're not.

Other providers (a `llama-server` you already run, OpenRouter in the cloud) and every knob are in [`docs/configuration.md`](../configuration.md).
