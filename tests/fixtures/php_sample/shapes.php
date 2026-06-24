<?php
namespace App\Models;

use App\Contracts\Repository;
use App\Support\Str as S;
require_once 'bootstrap.php';

define('VERSION', '1.0');

const GLOBAL_C = 5;

interface Shape {
    public function area(): float;
}

abstract class Base implements Shape {
    protected int $count = 0;
    public const MAX = 100;

    public function __construct(int $x) {
        $this->count = $x;
    }

    abstract public function area(): float;

    private function helper($a, $b) {
        return compute($a, $b);
    }
}

trait Greetable {
    public function greet(): string {
        return greeting();
    }
}

enum Suit {
    case Hearts;
    case Spades;
}

function topLevel(string $name): void {
    process($name);
}

$fn = function($x) { return $x * 2; };
$arrow = fn($x) => $x + 1;
