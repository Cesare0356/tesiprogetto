// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract L1Review {
    struct ReviewData {
        uint8 rating;   // 1..5
        bytes review;   // testo/bytes grezzi (in storage)
    }

    /// @dev Modalità unique: una entry per ciascun key calcolato.
    mapping(bytes32 => ReviewData) public revByKey;

    event ReviewStoredUnique(
        bytes32 indexed key,
        address indexed toAddress,
        address indexed userAddress,
        uint8 rating,
        uint256 len
    );

    /// @notice Scrive sempre in uno slot nuovo (chiave = keccak(user_address, to_address, nonce)).
    /// @dev Valida input e poi salva in storage.
    function leave_review_unique(
        address user_address,
        address to_address,
        uint256 nonce,
        uint8 rating,          // tipizzato stretto
        string calldata text
    ) external {
        // --- validazioni ---
        // rating tra 1 e 5
        require(rating >= 1 && rating <= 5, "rating out of range [1..5]");

        // lunghezza massima 512
        bytes memory b = bytes(text);
        uint256 len = b.length;
        require(len <= 1024, "text too long (>1024)");

        // caratteri ASCII stampabili: 32..126
        // (consente stringa vuota)
        for (uint256 i = 0; i < len; ) {
            uint8 c = uint8(b[i]);
            require(c >= 32 && c <= 126, "non-printable ASCII char");
            unchecked { ++i; }
        }

        // --- chiave unica per evitare overwrite (nuovi slot in storage) ---
        bytes32 key = keccak256(abi.encode(user_address, to_address, nonce));

        // --- scrittura in STORAGE ---
        // Assegno la struct: rating e bytes vanno in storage (len slot + ceil(len/32) slot dati)
        revByKey[key] = ReviewData({
            rating: rating,
            review: b
        });

        emit ReviewStoredUnique(key, to_address, user_address, rating, len);
    }

    function get_review_unique(bytes32 key)
        external
        view
        returns (uint8 rating, string memory text, bool exists)
    {
        ReviewData storage d = revByKey[key];
        // Poiche' rating valido e' [1..5], possiamo usare rating==0 come "non esiste".
        if (d.rating == 0) {
            return (0, "", false);
        }
        return (d.rating, string(d.review), true);
    }
}