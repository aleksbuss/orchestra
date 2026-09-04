// @vitest-environment happy-dom
/**
 * Regression coverage for PM #125 (POST_MORTEMS.md): a wide GFM table in an
 * assistant message rendered crushed into unreadable narrow columns instead
 * of triggering the bubble's overflow-x-auto scroll, and a model's literal
 * `<br>` (used to force a line break inside a table cell) showed up as
 * visible "<br>" text instead of an actual line break.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MessageBubble } from "./message-bubble";
import type { UIMessage } from "ai";

afterEach(cleanup);

function assistantMessage(text: string): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text }],
  } as unknown as UIMessage;
}

describe("<MessageBubble /> — GFM table rendering", () => {
  it("gives every th/td a min-width floor so a prose-heavy table can overflow instead of crushing", () => {
    const table = [
      "| Лицензия | Условия |",
      "| --- | --- |",
      "| MIT | Разрешено использовать, изменять, распространять без ограничений. |",
    ].join("\n");

    const { container } = render(<MessageBubble message={assistantMessage(table)} />);

    const cells = container.querySelectorAll("th, td");
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach((cell) => {
      expect(cell.className).toContain("min-w-[9rem]");
    });

    // The scroll container around the table must still be the overflow-x-auto
    // wrapper, not the table itself — that's what turns the forced min-width
    // into an actual scrollbar instead of a page-level overflow.
    const scrollWrapper = container.querySelector("table")?.parentElement;
    expect(scrollWrapper?.className).toContain("overflow-x-auto");
  });

  it("renders a literal <br> inside a table cell as a real line break, not literal text", () => {
    const table = ["| A |", "| --- |", "| line1<br>line2 |"].join("\n");

    const { container } = render(<MessageBubble message={assistantMessage(table)} />);

    expect(container.textContent).not.toContain("<br>");
    const cell = Array.from(container.querySelectorAll("td")).find((td) =>
      td.textContent?.includes("line1")
    );
    expect(cell?.querySelector("br")).not.toBeNull();
  });

  it("does not widen the raw-HTML surface for anything other than <br>", () => {
    const table = ["| A |", "| --- |", "| <img src=x onerror=alert(1)> text |"].join("\n");

    const { container } = render(<MessageBubble message={assistantMessage(table)} />);

    expect(container.querySelector("img")).toBeNull();
  });

  it("handles consecutive <br><br> (blank line inside a cell) as two separate breaks", () => {
    const table = ["| A |", "| --- |", "| one<br><br>two |"].join("\n");

    const { container } = render(<MessageBubble message={assistantMessage(table)} />);

    expect(container.textContent).not.toContain("<br>");
    const cell = Array.from(container.querySelectorAll("td")).find((td) =>
      td.textContent?.includes("one")
    );
    expect(cell?.querySelectorAll("br").length).toBe(2);
  });

  it("still applies GFM column alignment through the th/td overrides", () => {
    const table = ["| A | B |", "| :--- | ---: |", "| left | right |"].join("\n");

    const { container } = render(<MessageBubble message={assistantMessage(table)} />);

    const headers = container.querySelectorAll("th");
    expect(headers[0].style.textAlign).toBe("left");
    expect(headers[1].style.textAlign).toBe("right");
    // The min-width fix must not have dropped the alignment prop spread.
    expect(headers[1].className).toContain("min-w-[9rem]");
  });
});

describe("<MessageBubble /> — multi-part text join", () => {
  it("joins multiple text parts with a paragraph break instead of concatenating them", () => {
    const message = {
      id: "m2",
      role: "assistant",
      parts: [
        { type: "text", text: "First part." },
        { type: "text", text: "Second part." },
      ],
    } as unknown as UIMessage;

    const { container } = render(<MessageBubble message={message} />);

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0].textContent).toBe("First part.");
    expect(paragraphs[1].textContent).toBe("Second part.");
  });
});
