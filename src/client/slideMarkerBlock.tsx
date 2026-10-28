import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";

const slideMarkerSpec = createReactBlockSpec(
  {
    type: "slideMarker" as const,
    propSchema: {
      markerId: { default: "" as string },
    },
    content: "none" as const,
  },
  {
    render: ({ block }) => (
      <div
        data-testid="slide-marker"
        data-marker-id={block.props.markerId}
        contentEditable={false}
        style={{ userSelect: "none", padding: "4px 0" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            color: "#aaa",
            fontSize: "0.75rem",
          }}
        >
          <div style={{ flex: 1, height: 1, background: "#ddd" }} />
          <span>slide</span>
          <div style={{ flex: 1, height: 1, background: "#ddd" }} />
        </div>
      </div>
    ),
  },
)();

export const notemergeSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    slideMarker: slideMarkerSpec,
  },
});

export type NotemergeSchema = typeof notemergeSchema;
