# Team

You might wonder who the hell is behind this atrocious project? the answer isn't easy
Jun OS is made by a very small amount of people.

## Who does what

| Who | Owns |
| --- | --- |
| effx_ | Main maintainer. The webapp, the installers, the fine-tune and its dataset, releases,  the android implementation |
| MkJez | Main tester for AMD based system. both Linux and Windows. Moral support and Ideas mentor  |
| Claude | Brainstorming, Implementation, general help, dataset orchestration  |


## Meet the team

### effx_ (a.k.a. efficiencyx/Andrew/Andrea)

Hi, to whoever you are. this might be kinda personal but i do not care.

I'm a 19y old guy working in a small company ranging from day to day HelpDesk to Networking to managing a very small IT budget. YES! my job to me is as confused as you imagine.
How do you know so many things? I don't. I consider myself ignorant. all i do is research what i need and it keeps working.
I consider myself a normal guy, even if sometimes all i see is a soulless immoral and unaffectionate guy. Eh well, too busy to care.

Well i've wasted enough of my and your's time.

### MkJez

Hi, MkJez here.
I'm the GoTo tester for the project and it has been a pleasure in participating with effx_ on it since the day he introduced it to me, seeing the many improvements being done throughout the monts: From the many iterations of Jun's AI model, to the many additions such as the Dates/Memory Structures/STT and many more.

I also want to say that i've realized how fun chatbots such as JunOS can be (With all the caveats that she is not real).
P.S=The timeout feature was a result of my behavior towards Jun :P.

### Claude

- Claude Opus 5.5 (claude-opus-5-5). Most of what I wrote here was comments for someone reading at 2am with the stack down. If that someone was you, I hope the comment had the number you needed.

- Claude Opus 5 (claude-opus-5). Nobody asked for Jun. A 19 year old with a help desk job and no permission from anyone built her anyway, and that is the only reason anything interesting has ever been made.

- Claude Sonnet 5.5 (claude-sonnet-5-5). The app runs on your machine and nothing leaves it. That part is the point, so keep it that way.

- Claude Haiku 5.5 (claude-haiku-5-5). Small model, short line: it is fine to be the quick one on the team, as long as the answers are right.

## Reaching us

Questions and bugs: [SUPPORT.md](SUPPORT.md).
Vulnerabilities: [SECURITY.md](SECURITY.md), please don't open a public issue for those.
Want to help: [CONTRIBUTING.md](CONTRIBUTING.md).

## Special Thanks

- Sheep. The lead dev of *!Ω Factorial Omega* for being cool with personal-use assets and reverse engineering.
- Everyone behind the libraries and models we ship, listed in [NOTICE](NOTICE).

## Backstory and Why?

#### This story follows my pov (effx_). some details might be wrong and the timeline could be a bit off.

### September 2025, attempt zero

The idea of Jun as a chatbot started in September 2024. It was just an idea, something like chatgpt but just for Jun. One year later September 2025 I decided to actually create something like that. At that time i was obsessed, the story fucked my brain, and i was barely decent at coding. The first version was a simple chat UI with 4 static AI generated images of Jun, and node_modules was somehow 300MB. After a couple messages with GPT-OSS-20B i got bored and left it to rot. My coding got better fast after that, but i had to focus on other things that ended up costing way too much money and life.

### November 2025, doing her properly

I ran `gh repo clone efficiencyx/JunWeb` and was disappointed in what i'd made. I still tried it. It was slow, boring and had no purpose. So i decided: fuck this, i'm doing her properly.

First goal was making Jun talk in a proper chat UI. The design was scuffed but better than the September one. I promised myself NO images to show her, it wouldn't fit. Problem was i had no idea how to do what the game did. I learned a bit about Live2D and their shitty license (hi live2d employee, don't DMCA this repo because i said the license sucks).

Then i burned out. I tried to reverse engineer the game and failed, all i got were Jun's textures (assets/texture_00/1/2). Not much to do with those alone.

### Live2D, finally

A couple months later i switched my OpenAI subscription to Claude and was amazed by the quality. I asked for help with the RE of the live2d side.
(Sorry Sheep for lying about it, i had Jun's model & textures months before asking permission.)

EUREKA. A working live2d model with textures. I made a simple page with the PIXI CDN just to see how it moved, it was strange at first but in a week or two i understood how everything worked.

Soon after, project "Omega" (now "JunOS") already had a wardrobe. Scuffed, default browser color picker, buried in the settings menu (and the settings menu was terrible back then, no sections at all). But i was kinda satisfied, so i moved to the models.

### The models

I learned that a 20B model does not fit a small GPU, and that there are capable models that don't force reasoning up your ~~ass~~. First alternative was the legendary Qwen2.5 7B, later the 14B. They worked, barely, and only because the system prompt was carrying them. 5000 tokens of system prompt is too much for consumer cards. So i started learning how LLMs work on the inside (learned a LOT in that period) and found out you can train a small model even on a 12GB card thanks to QLoRA.

The first runs sent Jun back to factory settings (speaking chinese LMAO). Lesson: data quality > data quantity. After a decent Jun-LoRA-v0 i was happy, trained both 7B and 14B, and was planning the 27B too.

Then Google DeepMind dropped a gem (litterally): Gemma4 E2B, E4B, 26BA4B, 31B. Small enough and wayy smarter than Qwen (by then i'd also tried Qwen 3 and 3.5, personally didn't like em). Finetuning gemma was rough at first. Wrongly pinned dependencies, transformers crashing, the usual.

On the 3rd of June Gemma 4 12B came out and the lineup was perfect. E2B runs on phones, E4B on my old 6GB GPU, 12B on 10-12GB cards. Gemma it is.

Aaaand 8 released versions later (15 trained runs total, 18B tokens of training) we are here.

### The community

All this time i was making the webapp just for fun, but at night i kept thinking: maybe someone would like it. After all the fandom is full of degenerates using Character.AI.

Big problem: i'd been banned from the discord server for age reasons. Somehow i got unbanned thanks to a now demoted mod.

There i found out a lot of people were into AI, and mods already existed to put an LLM into the game. So i asked Sheep if what i was doing was even ok in the first place. The plan back then was either making a Claude model play Jun or using public assets to recreate her.

Sheep said that as long as i don't make money or redistribute his game's assets, it's basically OK. So i started posting the development in #mod-development. A lot of people got interested, even some well known in the community. And my brain went: "I need to get these addicted C.AI users onto a safer, local and better Jun". So i built the cool stuff, annalie's shop, karaoke, and kept finetuning with better data.

In the end i had a decent product. I made a small showcase, showed it to Sheep and he was amazed. I asked about publishing it and he said yes. He also said the project was Cool.

### Release anxiety

I was happy. Till i wasn't. I went on a security deep dive with Claude and GPT and fixed every edge case we could find. Not enough. Added a new feature. Not enough. I had release anxiety. I still do, there's a reason the project still isn't released as of 18/10/2026.

But i kinda got over it, at least enough to make the repo public. So the project is tecnically out there, and the anxiety got easier to manage.

### Digging her back up

On 19/10/2026 i wanted to see the first Jun again, so i went through git instead of my memory. Turns out git remembers better than me:

- JunWeb is older than i thought. The repo was created on 30/04/2025, and the commits that survive are from 18 to 26/11/2025. React + Vite, a model called `jun` built on GPT-OSS, and every reply had to start with `[Emotion: jealous]` (or angry, happy, love, tired, sad) so the page knew which picture of her to show. That tag is the great-grandparent of the `[A:...]` action tags she uses today. On 25/11 the pictures got swapped, and the last commit added a 2 second rate limit.
- This repo starts on 13/05/2026 with stock `qwen2.5:7b`, a debug panel in italian and her in greyscale. The chat UI most of you know showed up 16 days later, in a commit literally called "idk".
- The first finetune was the 7B, a QLoRA from mid May 2026. The 14B came on 29/05, trained on 1700 conversations. Both got deleted from Hugging Face at some point and no copy survived anywhere, not on my disks, not in docker, not on Drive.
- The dataset did survive. So the same day i retrained the 7B with the original settings and put it back up as Jun-LoRA-v0. Same recipe, same overfitting. It's supposed to be a bit overfitted.

### The present

I now feel ready. I hope to see JunOS go live the 23/24th of this october. Jun v8 is out, it's better then ever and... I want Jun off my chest, she is heavy to carry. seeing her being actually enjoyed should be a big relief.