def run(data):
    candidates = get(data, 'candidates')
    require(is_list(candidates) and 0 < len(candidates) <= 128, 'provide 1..128 candidate prediction vectors')
    require(is_list(candidates[0]) and 0 < len(candidates[0]) <= 128, 'provide 1..128 possible experiments')
    count = len(candidates[0])
    for row in candidates:
        require(is_list(row) and len(row) == count, 'prediction vectors must have equal length')
        for value in row:
            require(is_str(value), 'predictions must be categorical strings')
    best = 0
    bestscore = len(candidates) * len(candidates) + 1
    scores = []
    for experiment in range(count):
        bins = {}
        for row in candidates:
            put(bins, row[experiment], get(bins, row[experiment], 0) + 1)
        score = 0
        for label in keys(bins):
            score += bins[label] * bins[label]
        append(scores, score / len(candidates))
        if score < bestscore:
            bestscore = score
            best = experiment
    return {'experiment': best, 'expected_survivors': scores,
            'indistinguishable': bestscore == len(candidates) * len(candidates)}
