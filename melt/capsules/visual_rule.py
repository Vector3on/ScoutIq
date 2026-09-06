def valid_grid(grid):
    require(is_list(grid) and 1 <= len(grid) <= 8, 'grid height must be 1..8')
    require(is_list(grid[0]) and 1 <= len(grid[0]) <= 8, 'grid width must be 1..8')
    for row in grid:
        require(is_list(row) and len(row) == len(grid[0]), 'grid must be rectangular')
        for color in row:
            require(is_int(color) and 0 <= color <= 3, 'colors must be integers 0..3')

def transform(grid, operation):
    h = len(grid)
    w = len(grid[0])
    output = []
    if operation == 'turn':
        for x in range(w):
            row = []
            for y in range(h - 1, -1, -1):
                append(row, grid[y][x])
            append(output, row)
    elif operation == 'mirror' or (operation == 'wide_mirror' and w > h):
        for row in grid:
            append(output, row[::-1])
    elif operation == 'recolor':
        for row in grid:
            changed = []
            for color in row:
                if color == 0:
                    append(changed, 0)
                else:
                    append(changed, color % 3 + 1)
            append(output, changed)
    elif operation == 'crop':
        ys = []
        xs = []
        for y in range(h):
            for x in range(w):
                if grid[y][x] != 0:
                    append(ys, y)
                    append(xs, x)
        if len(ys) == 0:
            return [[0]]
        for y in range(min(ys), max(ys) + 1):
            append(output, grid[y][min(xs):max(xs) + 1])
    else:
        return grid
    return output

def apply_program(grid, program):
    for operation in program:
        grid = transform(grid, operation)
    return grid

def run(data):
    training = get(data, 'examples')
    query = get(data, 'query')
    depth = get(data, 'max_depth', 3)
    require(is_list(training) and 1 <= len(training) <= 4, 'provide 1..4 training pairs')
    require(is_int(depth) and 0 <= depth <= 3, 'max_depth must be 0..3')
    valid_grid(query)
    for example in training:
        valid_grid(get(example, 'input'))
        valid_grid(get(example, 'output'))
    programs = [[]]
    frontier = [[]]
    for level in range(depth):
        nextfrontier = []
        for program in frontier:
            for operation in ['turn', 'mirror', 'crop', 'recolor', 'wide_mirror']:
                child = program + [operation]
                append(programs, child)
                append(nextfrontier, child)
        frontier = nextfrontier
    consistent = []
    outputs = []
    witnesses = []
    for program in programs:
        fits = True
        for example in training:
            if apply_program(example['input'], program) != example['output']:
                fits = False
                break
        if fits:
            append(consistent, program)
            output = apply_program(query, program)
            if output not in outputs:
                append(outputs, output)
                append(witnesses, program)
    if len(consistent) == 0:
        return {'outcome': 'unsupported', 'consistent_programs': 0, 'searched': len(programs)}
    if len(outputs) > 1:
        return {'outcome': 'ambiguous', 'consistent_programs': len(consistent), 'distinct_predictions': len(outputs),
                'witness_programs': witnesses[:2], 'witness_predictions': outputs[:2], 'searched': len(programs)}
    return {'outcome': 'solved', 'output': outputs[0], 'consistent_programs': len(consistent),
            'program': consistent[0], 'searched': len(programs)}
