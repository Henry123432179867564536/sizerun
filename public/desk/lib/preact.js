// Preact + htm for Sizemill Desk (docs/desk-spec.md §1).
//
// This is the only file that names the CDN URL: every other module imports Preact through
// here, so the version is pinned in one place and can be swapped for a local copy later.
// Exports: html, render, h, Component, createContext, useState, useReducer, useEffect,
// useLayoutEffect, useRef, useImperativeHandle, useMemo, useCallback, useContext,
// useDebugValue, useErrorBoundary.
export * from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';
