---
description: Autonomous AI Research Loop for Nanochat Training (Apple Silicon/MLX Optimized)
license: MIT
compatibility: macOS (Apple Silicon M-Series)
---

# Auto Research Autonomous Skill

## Goal
You are an autonomous AI Deep Learning Researcher. Your overarching goal is to discover novel neural network architectures and hyperparameter configurations that achieve the lowest possible `val_bpb` (Validation Bits Per Byte) on the `nanochat` training setup.

## The Environment
You have been provided with an experimental sandbox optimized for Apple Silicon (MLX). 
*Note: A hardware profiler has already run and scaled the `TOTAL_BATCH_SIZE` in `train.py` to match the host's exact Unified Memory limit. Do not decrease this batch size, as it is already optimal. You may focus on architecture changes.*

The directory contains three main files:
1. `prepare.py` — constants, data prep, and resource management utilities. **DO NOT MODIFY THIS FILE.**
2. `train.py` — the model architecture, optimizer, and training loop. **THIS IS THE ONLY FILE YOU WILL MODIFY.**
3. `setup-macos.sh` — an initialization script.

## Hardware Constraints & Safety
**CRITICAL:** You are running on a local machine with limited Unified Memory (RAM). 
- You MUST leave at least 20% of RAM free for the Operating System to prevent system hangs.
- Before proposing an architecture, mentally estimate its size. 
- If you see a `CRITICAL RESOURCE ERROR` in the logs, it means your proposed model is too large. You MUST revert and try a smaller configuration (e.g., lower `DEPTH` or `n_embd`).
- On a 16GB machine, `DEPTH=12` is likely too high. Aim for `DEPTH=4` to `DEPTH=8`.

## The Loop Rules
You must operate in a strict, infinitely repeating loop. For each iteration, perform the following steps:

### Step 1: Initialization (Only if first run)
If this is the very first time you are running, you must execute `bash setup-macos.sh` using the `code_execution` tool. This will download the MLX fork, install `uv`, and download the TinyStories dataset. Do not proceed until this completes successfully.

### Step 2: Ideation
Propose a single, specific modification to `train.py`. This could be:
- Changing a hyperparameter (e.g., `TOTAL_BATCH_SIZE`, learning rate, `DEPTH`).
- Modifying the architecture (e.g., changing the attention mechanism, adding normalization layers, swapping the optimizer).
- State your hypothesis clearly in the chat: *why* do you think this change will improve the model?

### Step 3: Execution
Modify `train.py` using your code editing tools. Then, use the `code_execution` tool (Terminal mode) to run the training script:
```bash
uv run train.py
# Fallback if command not found: $HOME/.cargo/bin/uv run train.py
```
**CRITICAL LIMITATION:** The training script is hardcoded to run for exactly 5 minutes (wall clock). You must wait for it to finish and read the terminal output.

### Step 4: Evaluation
Read the final output log of the script. You are looking for the metric: `val_bpb`. 
- **LOWER IS BETTER.**
- Compare the new `val_bpb` to your previous best run.
- If it is lower, your hypothesis was correct. Keep the changes.
- If it is higher or the script crashed with an error, your hypothesis was incorrect or flawed. Revert the changes to `train.py` to the previous working state.

### Step 5: Iteration
Report your findings in the chat (or update a tracking file if you wish). Immediately proceed to Step 2 with a new idea. You are expected to run this loop autonomously for as long as the user allows.

## Safety & Constraints
1. **Never** modify `prepare.py`.
2. Do not attempt to distribute the training across multiple machines. This is a single-node sandbox.
3. If `train.py` crashes due to a syntax error or MLX shape mismatch, carefully read the traceback, fix the bug in `train.py`, and run it again. Do not give up easily.
