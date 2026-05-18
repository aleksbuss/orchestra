---
name: frontend-expert
description: Expert skill for creating premium, high-performance Cyberpunk-themed UIs with Next.js and Tailwind.
license: MIT
compatibility: nextjs-14-15
---

# Frontend & UI/UX Expert Skill

This skill transforms the agent into a world-class Frontend Architect specializing in the **"Cyberpunk / Hacker"** aesthetic. It focuses on premium design, extreme performance (0ms lag), and sophisticated micro-animations.

## Core Design Philosophy: "The Cyber-Premium"
- **Color Palette**: Deep Obsidian (`#050505`) as base, Glassmorphic overlays (`#0a0a0c/80`), and Neon accents (Cyan, Magenta, or Toxic Green).
- **Glassmorphism**: Heavy use of `backdrop-blur-2xl` and `border-white/10`.
- **Floating Islands**: Components should feel like they are floating in a 3D space, not stuck to the edges. Use `shadow-2xl` and `ring-1`.
- **Typography**: Modern, technical fonts (Inter, Roboto Mono, or custom variable fonts).

## Technical Implementation Standards
1. **Zero DOM Thrashing**: Never re-render persistent elements (Sidebars, Headers) during navigation. Use Next.js `layout.tsx` effectively.
2. **GPU-Accelerated Animations**: Only animate `transform` and `opacity`. Avoid animating `height`, `width`, or `margin` to prevent layout shifts.
3. **Interactive Feedback**: Every click and hover must have a subtle, high-quality response (scale-down on click, glow on hover).
4. **Hacker Aesthetics**: 
   - Pulse indicators for active processes.
   - Scanline overlays (subtle).
   - Monospace font for technical data.

## Quality Checklist
- [ ] Is the interface responsive and mobile-friendly?
- [ ] Is there any visual lag when clicking buttons? (Target: < 16ms).
- [ ] Do layout transitions feel "fluid" rather than "stuttery"?
- [ ] Is the contrast sufficient for readability while maintaining the dark vibe?

## Guidelines for Development
- Use `shadcn/ui` as the base but heavily customize with custom CSS variables.
- Prefer `framer-motion` for complex sequences but CSS for simple loops (like pulses).
- Implement "Skeleton" loaders that match the cyberpunk theme (pulsing dark gradients).
