# Term Retention Data Files

## frequency.txt

**Source:** Derived from the CREA (Corpus de Referencia del Español Actual) frequency ordering and supplemented with common Spanish vocabulary knowledge. The ordering approximates the most frequently used Spanish words in general written and spoken text.

**Licence:** Seed list assembled from general linguistic knowledge of Spanish word frequency; not a direct copy of any proprietary resource. Words and their relative frequency are considered facts not subject to copyright.

One word per line; line number equals rank (1 = most frequent).

`commonCutoff` default = 5000 (words at rank ≤ 5000 are dropped as too common for transcription hints).
`rareCutoff` default = 20000 (words absent from the list or at rank ≥ 20000 are kept as rare).

## head-neck-lexicon.txt

**Source:** Assembled from standard dental and orofacial anatomy curricula (Gray's Anatomy, Netter's Atlas of Human Anatomy) covering skull and facial bones, TMJ/ATM structures, muscles of mastication and the face, oral cavity, salivary glands, pharynx/larynx, cranial nerves, and vessels of the head and neck.

**Licence:** Anatomical term names are scientific facts not subject to copyright.

One term per line (lowercase). Regions below the neck are excluded.

## suffixes.txt

**Source:** Standard medical and dental suffixes from clinical terminology references (Dorland's Medical Dictionary, Diccionario de Términos Médicos RANM).

**Licence:** Suffix patterns are linguistic facts not subject to copyright.

One suffix per line (with leading hyphen, lowercase).
