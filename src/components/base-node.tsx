import { Tooltip2 } from "@blueprintjs/popover2";
import React, { memo } from "react";
import { Handle, Position } from "react-flow-renderer";
import { NodeIO } from "../types";
import styled from "@emotion/styled";
import { css, cx } from "@emotion/css";

export interface BaseNodeProps extends NodeIO {
  children: JSX.Element | JSX.Element[];
  className?: string;
  label?: string;
}

const Label = styled.div`
  text-transform: uppercase;
  vertical-align: super;
  font-weight: bold;
  font-size: 0.6em;
  line-height: 1em;
  letter-spacing: 0.1em;
  color: #5c7080;
  margin-bottom: 5px;
`;

function BaseNode({
  sources,
  sinks,
  label = "",
  children,
  className,
}: BaseNodeProps) {
  const targetHandles = Object.keys(sources).map((sourceName, i, keys) => (
    <Tooltip2
      key={i}
      content={sourceName}
      placement="bottom"
      portalClassName="handle-tooltip"
      renderTarget={({ ...tooltipProps }) => (
        <span
          style={{
            position: "absolute",
            top: 0,
            left: `${(100 * i + 50) / keys.length}%`,
          }}
          {...tooltipProps}
        >
          <Handle
            style={{
              left: `${(100 * i + 50) / keys.length}%`,
            }}
            type="target"
            position={Position.Top}
            id={sourceName}
            key={sourceName}
            className="semi-circle-drop semi-circle-drop-top"
          />
        </span>
      )}
    ></Tooltip2>
  ));
  const sourceHandles = Object.keys(sinks).map((sinkName, i, keys) => (
    <Tooltip2
      key={i}
      content={sinkName}
      placement="top"
      portalClassName="handle-tooltip"
      renderTarget={({ ...tooltipProps }) => (
        <span
          style={{
            position: "absolute",
            bottom: 0,
            left: `${(100 * i + 50) / keys.length}%`,
          }}
          {...tooltipProps}
        >
          <Handle
            style={{
              left: `${(100 * i + 50) / keys.length}%`,
            }}
            type="source"
            position={Position.Bottom}
            id={sinkName}
            key={sinkName}
            className="semi-circle-drop semi-circle-drop-bottom"
          />
        </span>
      )}
    ></Tooltip2>
  ));

  // Allow for spacing of handle drop zones (half zone width per side of handle)
  // Though for some reason there's still a touch of space between zones
  const minWidth =
    Math.max(Object.keys(sources).length, Object.keys(sinks).length) * 32;

  return (
    <div
      className={cx(
        css`
          background-color: white;
          min-width: ${minWidth};
          padding: 10px;
        `,
        className,
      )}
    >
      <Label>{label}</Label>
      {targetHandles}
      <div className="base-node-content">{children}</div>
      {sourceHandles}
    </div>
  );
}

export default memo(BaseNode);