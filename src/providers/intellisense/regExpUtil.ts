export function getBoundaryOffset(m: RegExpMatchArray): [number, number] {
    return [m.index!, m.index! + m[0].length];
}

export function containsOffset(m: RegExpMatchArray, offset: number) {
    let [s, e] = getBoundaryOffset(m);
    return offset >= s && offset <= e;
}
