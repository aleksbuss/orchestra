#!/bin/bash
set -e

echo "==========================================================="
echo "[setup-macos] Initializing MLX Autoresearch Sandbox..."
echo "==========================================================="

# Check if uv is installed
if ! command -v uv &> /dev/null; then
    echo "[setup-macos] 'uv' package manager not found. Installing astral/uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    
    # Try to add it to the current path dynamically for this session
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

# Clone the MLX repo directly into current directory if train.py is missing
if [ ! -f "train.py" ]; then
    echo "[setup-macos] Cloning trevin-creator/autoresearch-mlx fork (Apple Silicon Optimized)..."
    git clone https://github.com/trevin-creator/autoresearch-mlx.git temp-repo
    mv temp-repo/* temp-repo/.* . 2>/dev/null || true
    rm -rf temp-repo
else
    echo "[setup-macos] Source files already exist. Skipping clone."
fi

echo "[setup-macos] Installing dependencies via uv..."
uv sync

echo "[setup-macos] Running Apple Silicon Hardware Profiler..."
cat << 'EOF' > hardware-profiler.py
import os, subprocess, re

def get_ram_gb():
    try:
        res = subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True, check=True)
        return int(res.stdout.strip()) / (1024**3)
    except: return None

def main():
    ram = get_ram_gb()
    if not ram: return
    
    if ram <= 12: bs = 8192
    elif ram <= 36: bs = 16384
    elif ram <= 72: bs = 32768
    elif ram <= 128: bs = 65536
    else: bs = 131072
    
    print(f"[Hardware Profiler] Detected {ram:.1f}GB Unified Memory. Scaling TOTAL_BATCH_SIZE to {bs}")
    
    if os.path.exists('train.py'):
        with open('train.py', 'r') as f: content = f.read()
        content = re.sub(r'(TOTAL_BATCH_SIZE\s*=\s*)[^\n]+', rf'\g<1>{bs}', content)
        with open('train.py', 'w') as f: f.write(content)

if __name__ == "__main__": main()
EOF

uv run python hardware-profiler.py
rm hardware-profiler.py

echo "[setup-macos] Downloading TinyStories dataset and training tokenizer (~2 mins)..."
uv run prepare.py

echo "==========================================================="
echo "[setup-macos] Setup Complete! The sandbox is ready in the current directory."
echo "Agent: You can now begin your iteration loop directly in this folder."
echo "==========================================================="
