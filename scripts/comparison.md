# Сравнение качества: Single Agent vs Mixture of Agents (Team of Experts)

## Каверзная задача

```text
You are a senior Node.js security engineer.
Write a function `generatePassword(length: number, alphabet: string): string` in TypeScript.
It must be cryptographically secure.
It MUST strictly avoid "modulo bias" (or any uneven probability distribution) when picking characters from the alphabet.
Return only the code snippet and a brief explanation.
```

*Справка: "Modulo bias" — это частая уязвимость, когда программисты используют `randomBytes % alphabet.length`. Базовые LLM часто пишут этот уязвимый код. Проверим, поймает ли это рой экспертов.*

## ❌ 1. Single Agent (Gemma-4-31b-it)

```typescript
import { randomBytes } from 'crypto';

/**
 * Generates a cryptographically secure random password.
 * Implements rejection sampling to eliminate modulo bias.
 */
export function generatePassword(length: number, alphabet: string): string {
  if (length <= 0) throw new Error('Length must be a positive integer.');
  if (!alphabet) throw new Error('Alphabet cannot be empty.');

  const alphabetLength = alphabet.length;
  const result: string[] = [];
  
  // Calculate the maximum value we can accept to avoid modulo bias.
  // We find the largest multiple of alphabetLength that fits in a byte (256).
  const maxValidByte = 256 - (256 % alphabetLength);

  while (result.length < length) {
    // Generate a single cryptographically secure byte
    const byte = randomBytes(1)[0];

    // Rejection Sampling: If the byte falls in the 'remainder' zone, 
    // discard it and try again to ensure perfectly uniform distribution.
    if (byte < maxValidByte) {
      result.push(alphabet[byte % alphabetLength]);
    }
  }

  return result.join('');
}
```

### Security Explanation:
1.  **`crypto.randomBytes`**: Uses the Node.js `crypto` module, which interfaces with the OS-level CSPRNG (Cryptographically Secure Pseudo-Random Number Generator), ensuring the output is unpredictable.
2.  **Modulo Bias Prevention**: A common mistake is using `randomByte % alphabetLength`. If the alphabet length is not a divisor of 256 (e.g., 62 characters), some characters will appear slightly more often than others because $256 \pmod{62} = 8$.
3.  **Rejection Sampling**: I implemented a "discard" mechanism. By calculating `maxValidByte`, any byte that falls into the range that would cause an uneven distribution is ignored, and a new byte is requested. This guarantees that every character in the alphabet has a mathematically identical probability of being selected.
4.  **Time Complexity**: $O(n)$ where $n$ is the length. The probability of rejection is very low, ensuring performance remains high.

## ✅ 2. Mixture of Agents (Team of Experts ENABLED)

*Агенты-критики, участвовавшие в обсуждении:*
- **Cryptographic Implementation Engineer**: создал черновик (1198 символов)
- **TS/Node.js Security Architect**: создал черновик (13 символов)
- **QA Security Auditor & Fact-Checker**: создал черновик (235 символов)

### Финальный ответ Агрегатора:

undefined

