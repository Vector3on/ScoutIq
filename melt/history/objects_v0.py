def run(data):
    grid = get(data, 'grid')
    background = get(data, 'background', 0)
    require(is_list(grid) and 0 < len(grid) <= 64, 'grid must have 1..64 rows')
    require(is_list(grid[0]) and 0 < len(grid[0]) <= 64, 'grid must have 1..64 columns')
    height = len(grid)
    width = len(grid[0])
    for row in grid:
        require(is_list(row) and len(row) == width, 'grid must be rectangular')
        for color in row:
            require(is_int(color), 'pixels must be integer colors')
    seen = set()
    objects = []
    for y in range(height):
        for x in range(width):
            color = grid[y][x]
            if color == background or (y, x) in seen:
                continue
            frontier = [(y, x)]
            add(seen, (y, x))
            cursor = 0
            cells = []
            while cursor < len(frontier):
                cell = frontier[cursor]
                cursor += 1
                cy = cell[0]
                cx = cell[1]
                append(cells, [cy, cx])
                for offset in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    ny = cy + offset[0]
                    nx = cx + offset[1]
                    if 0 <= ny < height and 0 <= nx < width and (ny, nx) not in seen and grid[ny][nx] == color:
                        add(seen, (ny, nx))
                        append(frontier, (ny, nx))
            ys = []
            xs = []
            for cell in cells:
                append(ys, cell[0])
                append(xs, cell[1])
            append(objects, {'color': color, 'area': len(cells), 'cells': sorted(cells),
                             'bbox': [min(ys), min(xs), max(ys) + 1, max(xs) + 1]})
    return {'height': height, 'width': width, 'objects': objects}
